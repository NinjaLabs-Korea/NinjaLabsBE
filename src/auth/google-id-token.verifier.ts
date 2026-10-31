import { Injectable } from '@nestjs/common';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

export type GoogleIdTokenClaims = Pick<TokenPayload, 'iss' | 'aud' | 'sub' | 'email' | 'email_verified'>;

/** Google JWKS를 받아오지 못해 검증 자체를 못 한 경우 - 토큰이 잘못된 것이 아니므로 호출자는 503으로 매핑한다 */
export class GoogleVerifierUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GoogleVerifierUnavailableError';
  }
}

/** google-auth-library가 인증서 조회 실패를 감싸는 접두어 (oauth2client getFederatedSignonCertsAsync) */
const CERTS_FETCH_FAILED = /^Failed to retrieve verification certificates/;
/** 소켓/DNS 계열 오류 코드 (gaxios는 cause.code를 err.code로 올린다) */
const NETWORK_CODE = /^(ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_NETWORK)$/;

/**
 * Google id_token 서명 검증 - google-auth-library가 Google JWKS를 받아 캐시하고
 * 서명·만료·audience를 확인한다. 클레임(iss/sub/email_verified) 해석은 AuthService가 한다.
 *
 * 검증 실패(서명/만료/audience - 라이브러리는 평범한 Error에 메시지로 돌려준다)는 그대로 던지고,
 * JWKS 조회 실패(네트워크, DNS, 인증서 엔드포인트 비2xx)는 GoogleVerifierUnavailableError로 구분한다.
 */
@Injectable()
export class GoogleIdTokenVerifier {
  private readonly client = new OAuth2Client();

  async verify(idToken: string, audience: string): Promise<GoogleIdTokenClaims | undefined> {
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      return ticket.getPayload();
    } catch (err) {
      if (GoogleIdTokenVerifier.isUnavailable(err)) {
        throw new GoogleVerifierUnavailableError(err instanceof Error ? err.message : String(err), err);
      }
      throw err;
    }
  }

  static isUnavailable(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (CERTS_FETCH_FAILED.test(err.message)) return true;
    if (err.name === 'FetchError') return true;
    const { code, status, response } = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
    if (typeof code === 'string' && NETWORK_CODE.test(code)) return true;
    const httpStatus = typeof status === 'number' ? status : response?.status;
    return typeof httpStatus === 'number' && (httpStatus < 200 || httpStatus >= 300);
  }
}
