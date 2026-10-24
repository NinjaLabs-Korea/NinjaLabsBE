import { Injectable } from '@nestjs/common';
import { GoogleIdTokenClaims } from '../../auth/google-id-token.verifier';

/**
 * 외부 I/O 대역 — e2e에서 진짜와 바꾸는 것은 이 파일의 것뿐이다 (그 밖의 모든 provider·DB·HTTP 파이프라인은 실물).
 *
 *   FakeGoogle           Google 토큰 엔드포인트(https://oauth2.googleapis.com/token)를 fetch 수준에서 가로채고,
 *                        GoogleIdTokenVerifier(JWKS 서명 검증) 자리를 대신한다. 콜백의 `code`마다 미리 등록한 클레임을 돌려준다.
 *   FakeTurnstile        Cloudflare Turnstile siteverify(https://challenges.cloudflare.com/turnstile/v0/siteverify)를 fetch 수준에서 가로챈다.
 *                        `issueToken()`으로 만든 토큰만 1회 통과(그 뒤 timeout-or-duplicate), `outage`가 켜지면 네트워크 오류.
 *   FakeInjectiveNftClient  체인 민팅 클라이언트 — 미설정(isConfigured=false)으로 답해 nft_job 워커가 잡을 PENDING으로 미루게 한다.
 */
export const GOOGLE_CLIENT_ID_E2E = 'e2e-client.apps.googleusercontent.com';

export class FakeGoogle {
  private readonly claimsByCode = new Map<string, GoogleIdTokenClaims>();
  private readonly claimsByIdToken = new Map<string, GoogleIdTokenClaims>();
  tokenRequests: URLSearchParams[] = [];

  /** 콜백에 실어 보낼 Google `code`를 하나 만든다 — 토큰 엔드포인트가 이 code로 받으면 해당 클레임의 id_token을 돌려준다 */
  issueCode(claims: Partial<GoogleIdTokenClaims> & { sub: string; email: string }): string {
    const code = `4/e2e-${Math.random().toString(36).slice(2)}`;
    this.claimsByCode.set(code, { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID_E2E, email_verified: true, ...claims });
    return code;
  }

  /** fetch 가로채기 — Google 토큰 엔드포인트만 응답하고, 다른 외부 URL은 테스트를 실패시킨다 (외부로 새는 호출 감지) */
  async handleFetch(url: string, init?: RequestInit): Promise<Response> {
    if (url !== 'https://oauth2.googleapis.com/token') throw new Error(`e2e: unexpected external fetch to ${url}`);
    const form = new URLSearchParams(String(init?.body ?? ''));
    this.tokenRequests.push(form);
    const claims = this.claimsByCode.get(form.get('code') ?? '');
    if (!claims) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    this.claimsByCode.delete(form.get('code')!);
    const idToken = `e2e-id-token.${Math.random().toString(36).slice(2)}`;
    this.claimsByIdToken.set(idToken, claims);
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'ya29.e2e' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  /** GoogleIdTokenVerifier.verify 자리 — audience 불일치는 라이브러리처럼 Error */
  readonly verifier = {
    verify: async (idToken: string, audience: string): Promise<GoogleIdTokenClaims | undefined> => {
      const claims = this.claimsByIdToken.get(idToken);
      if (!claims) throw new Error('Wrong number of segments in token');
      if (audience !== GOOGLE_CLIENT_ID_E2E) throw new Error('Wrong recipient, payload audience != requiredAudience');
      return claims;
    },
  };
}

export const TURNSTILE_SITEVERIFY_URL_E2E = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class FakeTurnstile {
  private readonly valid = new Set<string>();
  requests: URLSearchParams[] = [];
  /** true면 siteverify가 네트워크 오류를 낸다 (503 TURNSTILE_UNAVAILABLE 경로) */
  outage = false;

  /** 위젯이 브라우저에 주는 토큰 하나 — siteverify에서 한 번만 success:true */
  issueToken(): string {
    const token = `0.e2e-turnstile-${Math.random().toString(36).slice(2)}`;
    this.valid.add(token);
    return token;
  }

  async handleFetch(init?: RequestInit): Promise<Response> {
    if (this.outage) throw new TypeError('fetch failed');
    const form = new URLSearchParams(String(init?.body ?? ''));
    this.requests.push(form);
    const token = form.get('response') ?? '';
    const success = this.valid.delete(token);
    return new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
}

@Injectable()
export class FakeInjectiveNftClient {
  mints: Array<{ tokenId: string; owner: string }> = [];
  isConfigured(): boolean { return false; }
  contractAddress(): string { return 'inj1e2econtract'; }
  async tokenExists(): Promise<boolean> { return false; }
  async mint(tokenId: string, owner: string): Promise<string> {
    this.mints.push({ tokenId, owner });
    return `0x${'ab'.repeat(32)}`;
  }
}
