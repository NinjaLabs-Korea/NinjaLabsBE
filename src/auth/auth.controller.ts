import {
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
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty } from 'class-validator';
import { Request, Response } from 'express';
import {
  onboardingError,
  onboardingLog,
  requestTraceId,
} from '../common/logging/onboarding-log';
import { AuthGuard } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';

class RefreshDto {
  @IsNotEmpty()
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** GET /auth/google — 구글 동의 화면으로 리다이렉트 */
  @Get('google')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleRedirect(@Query('trace') traceId: string | undefined, @Res() res: Response) {
    onboardingLog(this.logger, 'oauth.redirect.requested', { traceId });
    const state = await this.auth.issueOauthState(traceId);
    onboardingLog(this.logger, 'oauth.redirect.ready', { traceId });
    res.redirect(this.auth.buildGoogleAuthUrl(state));
  }

  /**
   * GET /auth/google/callback — code 교환 → 세션 발급 → FE로 리다이렉트
   * 토큰은 URL fragment(#)로 전달 — fragment는 서버로 전송되지 않아 로그에 남지 않고,
   * FE 계약(refresh를 body로 보내는 방식)상 FE JS가 토큰을 직접 보관해야 한다.
   */
  @Get('google/callback')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fe = this.config.get<string>('AUTH_SUCCESS_REDIRECT') ?? 'http://localhost:3000/';
    onboardingLog(this.logger, 'oauth.callback.received', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      providerError: error ?? null,
    });
    if (error || !code || !state) {
      onboardingLog(this.logger, 'oauth.callback.rejected', {
        reason: error ?? 'MISSING_CODE_OR_STATE',
      });
      return res.redirect(`${fe}#error=${encodeURIComponent(error ?? 'MISSING_CODE')}`);
    }
    try {
      const traceId = await this.auth.verifyOauthState(state);
      onboardingLog(this.logger, 'oauth.state.verified', { traceId });
      const { googleId, email } = await this.auth.exchangeGoogleCode(code);
      onboardingLog(this.logger, 'oauth.google.exchange.succeeded', { traceId });
      const user = await this.auth.upsertGoogleUser(googleId, email);
      onboardingLog(this.logger, 'oauth.user.resolved', {
        traceId,
        userId: user.id,
        onboardingStep: user.onboarding_step,
        onboardingCompleted: user.onboarding_completed_at !== null,
      });
      const { accessToken, refreshToken } = await this.auth.issueSession(
        user.id,
        user.is_admin,
        req.ip,
        req.headers['user-agent'],
      );
      onboardingLog(this.logger, 'oauth.session.issued', { traceId, userId: user.id });
      const params = new URLSearchParams({ accessToken, refreshToken });
      onboardingLog(this.logger, 'oauth.callback.redirecting', { traceId, userId: user.id });
      return res.redirect(`${fe}#${params}`);
    } catch (caught) {
      onboardingError(this.logger, 'oauth.callback.failed', caught);
      // 실패 사유를 FE에 상세 노출하지 않는다 (code/state 탈취 시도 힌트 방지)
      return res.redirect(`${fe}#error=AUTH_FAILED`);
    }
  }

  /** POST /auth/refresh — 토큰 재발급 (refresh token 회전: 응답의 새 refreshToken으로 교체 필수) */
  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // 무차별 대입 방어
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    const traceId = requestTraceId(req.headers);
    onboardingLog(this.logger, 'session.refresh.requested', { traceId });
    try {
      const session = await this.auth.refresh(dto.refreshToken, req.ip, req.headers['user-agent']);
      onboardingLog(this.logger, 'session.refresh.succeeded', { traceId });
      return session;
    } catch (caught) {
      onboardingError(this.logger, 'session.refresh.failed', caught, { traceId });
      throw caught;
    }
  }

  /** POST /auth/logout — refresh 세션 폐기 */
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.revoke(dto.refreshToken);
  }

  /** GET /auth/me — 현재 세션 유저 프로필 + 온보딩/지갑/NFT 상태 */
  @Get('me')
  @Header('Cache-Control', 'no-store, private')
  @UseGuards(AuthGuard)
  async me(@Req() req: Request & { user: SessionUser }) {
    const traceId = requestTraceId(req.headers);
    onboardingLog(this.logger, 'session.me.requested', { traceId, userId: req.user.userId });
    try {
      const me = await this.auth.getMe(req.user.userId);
      onboardingLog(this.logger, 'session.me.succeeded', {
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
        traceId,
        userId: req.user.userId,
      });
      throw caught;
    }
  }
}
