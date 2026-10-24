import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Request, Response } from 'express';
import {
  onboardingError,
  onboardingLog,
  requestTraceId,
} from '../common/logging/onboarding-log';
import { requestIdOf } from '../common/http/request-id';
import { AUTH_PROXIED_ROUTE_IP_THROTTLE, AuthTokenThrottlerGuard } from './auth-throttler.guard';
import { AuthGuard } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';
import { clearRefreshCookie, isCookieMode, readRefreshCookie, setRefreshCookie } from './session-cookie';
import { authSuccessRedirectUrl, feRedirectAllowlist } from './fe-origins';
import { TurnstileVerifier } from './turnstile.verifier';

/**
 * `/auth/refresh`·`/auth/logout` 본문. 쿠키 모드(`X-Ninja-Session: cookie`)에서는 비어 있어도 되므로 선택 필드이고,
 * 본문 모드에서 빠지면 컨트롤러가 예전 ValidationPipe와 **같은 400 본문**을 낸다 (REFRESH_TOKEN_REQUIRED).
 */
class RefreshDto {
  // IsString: 숫자/객체가 오면 createHash().update()가 TypeError를 던져 500이 됐다 (인증 없이 호출되는 경로)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}

/** 본문 모드에서 refreshToken이 빠졌을 때 — 필수 필드였던 시절 ValidationPipe가 내던 메시지와 동일 (FE/스크립트 호환) */
const REFRESH_TOKEN_REQUIRED = ['refreshToken should not be empty', 'refreshToken must be a string'];

class LoginCodeDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  code!: string;

  @Matches(/^[A-Za-z0-9._~-]{43,128}$/)
  codeVerifier!: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly turnstile: TurnstileVerifier,
  ) {}

  private authSuccessRedirect(requested?: string): string {
    const fallback = authSuccessRedirectUrl(this.config);
    // 기본값이 URL이 아니면 returnTo도 받지 않는다
    if (!requested || !URL.canParse(fallback)) return fallback;

    try {
      // 기본 리다이렉트 오리진 + AUTH_ALLOWED_REDIRECT_ORIGINS (정확한 오리진 또는 `*` 와일드카드 1개) — fe-origins.ts
      const allowedOrigins = feRedirectAllowlist(this.config);
      const requestedUrl = new URL(requested);
      if (!allowedOrigins.allows(requestedUrl.origin)) return fallback;
      return `${requestedUrl.origin}/`;
    } catch {
      return fallback;
    }
  }

  /**
   * GET /auth/google — 구글 동의 화면으로 리다이렉트.
   * `TURNSTILE_SECRET_KEY`가 설정돼 있으면 `turnstileToken`(Cloudflare Turnstile 위젯 토큰)을 먼저 siteverify로 검증한다 —
   * 없음/거절 400 TURNSTILE_FAILED, Cloudflare 불통 503 TURNSTILE_UNAVAILABLE (turnstile.verifier.ts). state 발급 전에 검사한다.
   */
  @Get('google')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleRedirect(
    @Query('trace') traceId: string | undefined,
    @Query('returnTo') returnTo: string | undefined,
    @Query('codeChallenge') codeChallenge: string | undefined,
    @Query('turnstileToken') turnstileToken: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rid = requestIdOf(req);
    if (this.turnstile.enabled) {
      try {
        await this.turnstile.verify(typeof turnstileToken === 'string' ? turnstileToken : undefined, req.ip);
      } catch (caught) {
        onboardingError(this.logger, 'oauth.turnstile.rejected', caught, { rid, traceId });
        throw caught;
      }
      onboardingLog(this.logger, 'oauth.turnstile.verified', { rid, traceId });
    }
    const redirectUrl = this.authSuccessRedirect(returnTo);
    onboardingLog(this.logger, 'oauth.redirect.requested', {
      rid,
      traceId,
      requestedReturnOrigin: returnTo ? this.safeOrigin(returnTo) : null,
      selectedReturnOrigin: this.safeOrigin(redirectUrl),
    });
    const state = await this.auth.issueOauthState(traceId, redirectUrl, codeChallenge ?? '');
    onboardingLog(this.logger, 'oauth.redirect.ready', { rid, traceId });
    res.redirect(this.auth.buildGoogleAuthUrl(state));
  }

  /**
   * GET /auth/google/callback — Google code 교환 → 일회용 로그인 코드 → FE.
   * Access/refresh tokens are returned only by POST /auth/exchange, never in a URL.
   */
  @Get('google/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rid = requestIdOf(req);
    let fe = this.authSuccessRedirect();
    onboardingLog(this.logger, 'oauth.callback.received', {
      rid,
      hasCode: Boolean(code),
      hasState: Boolean(state),
      providerError: error ?? null,
    });
    if (error || !code || !state) {
      onboardingLog(this.logger, 'oauth.callback.rejected', {
        rid,
        reason: error ?? 'MISSING_CODE_OR_STATE',
      });
      return res.redirect(this.loginCallbackUrl(fe, { error: 'AUTH_FAILED' }));
    }
    try {
      const oauthState = await this.auth.verifyOauthState(state);
      const traceId = oauthState.traceId;
      fe = this.authSuccessRedirect(oauthState.redirectUrl);
      onboardingLog(this.logger, 'oauth.state.verified', { rid, traceId });
      const { googleId, email } = await this.auth.exchangeGoogleCode(code);
      onboardingLog(this.logger, 'oauth.google.exchange.succeeded', { rid, traceId });
      const user = await this.auth.upsertGoogleUser(googleId, email);
      onboardingLog(this.logger, 'oauth.user.resolved', {
        rid,
        traceId,
        userId: user.id,
        onboardingStep: user.onboarding_step,
        onboardingCompleted: user.onboarding_completed_at !== null,
      });
      const loginCode = await this.auth.issueLoginCode(user.id, oauthState.codeChallenge);
      onboardingLog(this.logger, 'oauth.callback.redirecting', { rid, traceId, userId: user.id });
      return res.redirect(this.loginCallbackUrl(fe, { loginCode }));
    } catch (caught) {
      onboardingError(this.logger, 'oauth.callback.failed', caught, { rid });
      // 실패 사유를 FE에 상세 노출하지 않는다 (code/state 탈취 시도 힌트 방지)
      return res.redirect(this.loginCallbackUrl(fe, { error: 'AUTH_FAILED' }));
    }
  }

  private loginCallbackUrl(fe: string, params: Record<string, string>): string {
    const url = new URL('/auth/callback', fe);
    url.hash = new URLSearchParams(params).toString();
    return url.toString();
  }

  /**
   * POST /auth/exchange — 로그인 코드 + PKCE verifier → 세션.
   * 쿠키 모드(`X-Ninja-Session: cookie`): refresh는 `Set-Cookie: ninja_rt=…`로만 주고 본문에서 뺀다 (session-cookie.ts).
   * 한도: 로그인 코드 해시별 10/min (AuthTokenThrottlerGuard) + IP당 600/min (전역 120/min을 이 라우트만 올림 — AUTH_PROXIED_ROUTE_IP_THROTTLE).
   */
  @Post('exchange')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  @Throttle(AUTH_PROXIED_ROUTE_IP_THROTTLE)
  @UseGuards(AuthTokenThrottlerGuard)
  async exchange(@Body() dto: LoginCodeDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.exchangeLoginCode(dto.code, dto.codeVerifier, req.ip, req.headers['user-agent']);
    return isCookieMode(req) ? this.toCookieSession(session, res) : session;
  }

  private safeOrigin(value: string): string | null {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  /**
   * POST /auth/refresh — 토큰 재발급 (refresh token 회전).
   *   - 본문 모드(deprecated): `{refreshToken}` → `{accessToken, refreshToken}` — 응답의 새 refreshToken으로 교체 필수. 쿠키는 무시.
   *   - 쿠키 모드(`X-Ninja-Session: cookie`): `ninja_rt` 쿠키를 읽어 회전하고 새 토큰을 다시 쿠키로 → 본문 `{accessToken}`.
   *     본문에 `refreshToken`이 함께 오면(localStorage 레거시 토큰의 1회 이전) 본문 토큰을 쓰고 결과를 쿠키로 심는다.
   *     쿠키에서 읽은 토큰이 401이면 쿠키도 지운다 (죽은 세션).
   * 한도: 제시된 refresh 토큰 해시별 10/min (AuthTokenThrottlerGuard — Vercel 프록시의 공유 IP로 버킷이 섞이지 않게) + IP당 600/min
   * (전역 120/min을 이 라우트만 올림 — AUTH_PROXIED_ROUTE_IP_THROTTLE).
   */
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  @Throttle(AUTH_PROXIED_ROUTE_IP_THROTTLE)
  @UseGuards(AuthTokenThrottlerGuard)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const traceId = requestTraceId(req.headers);
    const rid = requestIdOf(req);
    const cookieMode = isCookieMode(req);
    const fromCookie = cookieMode && !dto.refreshToken ? readRefreshCookie(req) : undefined;
    const refreshToken = dto.refreshToken ?? fromCookie;
    if (!refreshToken) {
      if (!cookieMode) throw new BadRequestException(REFRESH_TOKEN_REQUIRED);
      onboardingLog(this.logger, 'session.refresh.rejected', { rid, traceId, reason: 'NO_REFRESH_COOKIE' });
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }
    onboardingLog(this.logger, 'session.refresh.requested', { rid, traceId, mode: cookieMode ? (fromCookie ? 'cookie' : 'cookie-migrate') : 'body' });
    try {
      const session = await this.auth.refresh(refreshToken, req.ip, req.headers['user-agent']);
      onboardingLog(this.logger, 'session.refresh.succeeded', { rid, traceId });
      return cookieMode ? this.toCookieSession(session, res) : session;
    } catch (caught) {
      onboardingError(this.logger, 'session.refresh.failed', caught, { rid, traceId });
      if (fromCookie && caught instanceof UnauthorizedException) clearRefreshCookie(res);
      throw caught;
    }
  }

  /**
   * POST /auth/logout — refresh 세션 폐기, 204.
   * 쿠키 모드: 쿠키(와 본문에 함께 온 레거시 토큰)의 세션을 폐기하고 쿠키를 지운다(`Max-Age=0`, 같은 Path/속성). 토큰이 없어도 204.
   * 한도: refresh와 같다 — 제시된 refresh 토큰 해시별 10/min (AuthTokenThrottlerGuard, 토큰이 없으면 건너뜀) + IP당 600/min
   * (Vercel rewrite로 오는 라우트라 전역 120/min을 올림 — AUTH_PROXIED_ROUTE_IP_THROTTLE).
   */
  @Post('logout')
  @HttpCode(204)
  @Throttle(AUTH_PROXIED_ROUTE_IP_THROTTLE)
  @UseGuards(AuthTokenThrottlerGuard)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!isCookieMode(req)) {
      if (!dto.refreshToken) throw new BadRequestException(REFRESH_TOKEN_REQUIRED);
      await this.auth.revoke(dto.refreshToken);
      return;
    }
    const tokens = new Set([dto.refreshToken, readRefreshCookie(req)].filter((token): token is string => Boolean(token)));
    for (const token of tokens) await this.auth.revoke(token);
    clearRefreshCookie(res);
  }

  /** 쿠키 모드 응답 — refresh는 HttpOnly 쿠키로만, 본문에서는 뺀다 (그 밖의 필드는 그대로) */
  private toCookieSession<T extends { refreshToken: string }>(session: T, res: Response): Omit<T, 'refreshToken'> {
    const { refreshToken, ...rest } = session;
    setRefreshCookie(res, refreshToken, this.auth.refreshTtlSeconds);
    return rest;
  }

  /** GET /auth/me — 현재 세션 유저 프로필 + 온보딩/지갑/NFT 상태 */
  @Get('me')
  @Header('Cache-Control', 'no-store, private')
  @UseGuards(AuthGuard)
  async me(@Req() req: Request & { user: SessionUser }) {
    const traceId = requestTraceId(req.headers);
    const rid = requestIdOf(req);
    onboardingLog(this.logger, 'session.me.requested', { rid, traceId, userId: req.user.userId });
    try {
      const me = await this.auth.getMe(req.user.userId);
      onboardingLog(this.logger, 'session.me.succeeded', {
        rid,
        traceId,
        userId: req.user.userId,
        onboardingStep: me.onboardingStep,
        onboardingCompleted: me.onboardingCompleted,
        walletLinked: me.wallet !== null,
        nftStatus: me.nft?.status ?? null,
      });
      return me;
    } catch (caught) {
      onboardingError(this.logger, 'session.me.failed', caught, {
        rid,
        traceId,
        userId: req.user.userId,
      });
      throw caught;
    }
  }
}
