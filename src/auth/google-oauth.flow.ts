import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  GoogleIdTokenClaims,
  GoogleIdTokenVerifier,
  GoogleVerifierUnavailableError,
} from './google-id-token.verifier';

/**
 * Google OAuth 왕복의 단일 출처 — state 발급/검증, 동의 화면 URL, code → 구글 프로필 교환.
 * AuthService의 issueOauthState / verifyOauthState / buildGoogleAuthUrl / exchangeGoogleCode가 이 클래스에 위임한다.
 *
 * 여기를 고치는 경우:
 *   - 요청 스코프(openid email)나 동의 화면 옵션 → buildGoogleAuthUrl (스코프를 늘리면 docs/runbook.md의 심사 판단도 다시 본다).
 *   - state 수명(10분)·PKCE challenge 형식 → issueOauthState / verifyOauthState (두 곳의 정규식은 같아야 한다).
 *   - id_token 클레임 재확인(iss/aud/sub/email/email_verified) → exchangeGoogleCode. 서명 검증 자체는 google-id-token.verifier.ts.
 * 받은 프로필로 유저를 찾거나 만드는 것은 여기가 아니라 AuthService.upsertGoogleUser다.
 */

/** Google 토큰 엔드포인트를 기다리는 최대 시간 — 넘기면 503 GOOGLE_UNAVAILABLE (콜백 요청이 무한정 매달리지 않게) */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

export interface OAuthState {
  traceId?: string;
  redirectUrl?: string;
  codeChallenge: string;
}

/** PKCE S256 code_challenge 형식 (base64url sha256 = 43자) — state 발급과 검증이 같은 규칙을 쓴다 */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export class GoogleOAuthFlow {
  /**
   * @param logger AuthService의 로거를 그대로 받는다 — 로그 컨텍스트가 `AuthService`로 유지된다 (e2e identity-edges가 이 컨텍스트로 찾는다)
   */
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly googleVerifier: GoogleIdTokenVerifier,
    private readonly logger: Logger,
  ) {}

  private googleClientId(): string {
    const id = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!id) throw new Error('GOOGLE_CLIENT_ID is not configured');
    return id;
  }

  /**
   * CSRF 방어용 state — 서명된 단기 JWT라 서버 측 저장소/쿠키 없이 검증 가능.
   * 콜백에서 서명·만료·용도(p)를 확인한다.
   */
  async issueOauthState(traceId: string | undefined, redirectUrl: string, codeChallenge: string): Promise<string> {
    // typeof: `?codeChallenge[]=<43자>`는 배열로 들어오는데 RegExp.test가 문자열로 바꿔 통과시킨다 — state의 c가 배열이 되어 콜백(구글 왕복 뒤)에서야 AUTH_FAILED로 깨졌다
    if (typeof codeChallenge !== 'string' || !CODE_CHALLENGE.test(codeChallenge)) {
      throw new UnauthorizedException('INVALID_CODE_CHALLENGE');
    }
    const safeTraceId = typeof traceId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(traceId) ? traceId : undefined;
    return this.jwt.signAsync(
      { p: 'gstate', t: safeTraceId, r: redirectUrl, c: codeChallenge },
      { expiresIn: '10m' },
    );
  }

  async verifyOauthState(state: string): Promise<OAuthState> {
    try {
      const payload = await this.jwt.verifyAsync<{ p?: string; t?: string; r?: string; c?: string }>(state);
      if (payload.p !== 'gstate' || typeof payload.c !== 'string' || !CODE_CHALLENGE.test(payload.c)) {
        throw new Error('invalid state');
      }
      return { traceId: payload.t, redirectUrl: payload.r, codeChallenge: payload.c };
    } catch {
      throw new UnauthorizedException('INVALID_OAUTH_STATE');
    }
  }

  buildGoogleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.googleClientId(),
      redirect_uri: this.config.get<string>('GOOGLE_CALLBACK_URL') ?? '',
      response_type: 'code',
      scope: 'openid email',
      state,
      // 매 로그인마다 계정 선택 화면 노출 (공용 PC에서 자동 재로그인 방지)
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  /** code → 토큰 교환 후 구글 프로필(google_id, email) 반환 */
  async exchangeGoogleCode(code: string): Promise<{ googleId: string; email: string }> {
    const form = new URLSearchParams({
      code,
      client_id: this.googleClientId(),
      client_secret: this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '',
      redirect_uri: this.config.get<string>('GOOGLE_CALLBACK_URL') ?? '',
      grant_type: 'authorization_code',
    });
    let res: Response;
    try {
      res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      // 네트워크 오류·타임아웃은 코드 탓이 아니다 — id_token JWKS 조회 실패와 같이 503 (콜백은 어느 쪽이든 #error=AUTH_FAILED)
      this.logger.warn(`Google token endpoint unavailable: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      throw new ServiceUnavailableException('GOOGLE_UNAVAILABLE');
    }
    if (!res.ok) throw new UnauthorizedException('GOOGLE_CODE_EXCHANGE_FAILED');
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new UnauthorizedException('GOOGLE_CODE_EXCHANGE_FAILED');

    // id_token 서명을 Google JWKS로 검증한다 (google-auth-library: 서명·만료·audience).
    // 그 위에 iss/aud/sub/email/email_verified 클레임을 한 번 더 확인한다.
    // 검증 실패(서명/만료/audience)는 401, Google JWKS를 못 받아온 것(네트워크/비2xx)은 503 — 토큰 탓이 아니다.
    let claims: GoogleIdTokenClaims | undefined;
    try {
      claims = await this.googleVerifier.verify(body.id_token, this.googleClientId());
    } catch (err) {
      if (err instanceof GoogleVerifierUnavailableError) {
        this.logger.warn(`Google id_token verification unavailable: ${err.message}`);
        throw new ServiceUnavailableException('GOOGLE_UNAVAILABLE');
      }
      throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');
    }
    if (!claims) throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');

    const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issOk || claims.aud !== this.googleClientId() || !claims.sub || !claims.email) {
      throw new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN');
    }
    if (claims.email_verified === false) {
      throw new UnauthorizedException('GOOGLE_EMAIL_NOT_VERIFIED');
    }
    return { googleId: claims.sub, email: claims.email };
  }
}
