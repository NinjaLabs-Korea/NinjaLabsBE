import { LoggerService } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'crypto';
import { HDNodeWallet, Wallet } from 'ethers';
import { request as httpRequest, IncomingHttpHeaders } from 'http';
import { AddressInfo } from 'net';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app-setup';
import { GoogleIdTokenVerifier } from '../../auth/google-id-token.verifier';
import { DatabaseService } from '../../common/database/database.service';
import { InjectiveNftClient } from '../../nfts/injective-nft.client';
import { TEST_DB_URL_ENV } from '../../test-db/harness';
import { FakeGoogle, FakeInjectiveNftClient, FakeTurnstile, GOOGLE_CLIENT_ID_E2E, TURNSTILE_SITEVERIFY_URL_E2E } from './fakes';

/**
 * HTTP e2e 하네스 — `npm run test:e2e` (jest.e2e.config.js).
 *
 * 진짜 AppModule 전체를 main.ts와 같은 `configureApp()`(src/app-setup.ts)으로 구성해 `listen(0)` 하고, node:http로 요청을 보낸다.
 * DB는 test-db와 같은 global-setup이 만든 새 데이터베이스(모든 마이그레이션 적용). 바꾸는 것은 외부 I/O뿐이다 (support/fakes.ts):
 * Google 토큰 엔드포인트(fetch 가로채기) + id_token 검증기, Injective 민팅 클라이언트. 그 밖의 외부 fetch는 테스트를 실패시킨다.
 *
 * 환경: ConfigModule은 process.env를 .env보다 우선하므로, 앱이 읽는 키를 **전부** 여기서 덮어쓴다 — 개발자의 .env(실제 시크릿·DB)가
 * 새어 들어오지 않는다. TRUST_PROXY=1이라 요청마다 기본으로 무작위 X-Forwarded-For를 붙여 IP별 throttler 버킷을 나눈다
 * (한 파일의 요청이 전역 120/min에 걸리지 않게). throttling 스펙은 `ip`를 직접 지정한다.
 *
 * 로그: 모든 Nest 로그를 `logs`에 모으고, `close()`가 시크릿(환경 시크릿·발급된 토큰·API 키·로그인 코드)이 한 줄도 없는지 단언한다.
 */
export const E2E_SECRETS = {
  JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef-0123456789abcdef',
  GOOGLE_CLIENT_SECRET: 'e2e-google-client-secret-GOCSPX-zzzz',
  MASTER_WALLET_MNEMONIC: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
} as const;
export const FE_ORIGIN = 'http://localhost:3000';
export const PREVIEW_ORIGIN = 'https://ninjalabsfe-git-develop-team.vercel.app';

export function e2eEnv(): Record<string, string> {
  const url = process.env[TEST_DB_URL_ENV];
  if (!url) throw new Error(`${TEST_DB_URL_ENV} is not set — jest.e2e.config.js global-setup did not run`);
  return {
    NODE_ENV: 'test',
    PORT: '0',
    DATABASE_URL: url,
    PGSSLMODE: process.env.TEST_PGSSLMODE ?? 'disable',
    DATABASE_CA_CERT: '',
    TRUST_PROXY: '1',
    CORS_ORIGINS: `${FE_ORIGIN},${PREVIEW_ORIGIN},https://ninjalabsfe-*-team.vercel.app`,
    AUTH_SUCCESS_REDIRECT: `${FE_ORIGIN}/`,
    AUTH_ALLOWED_REDIRECT_ORIGINS: `${PREVIEW_ORIGIN},https://ninjalabsfe-*-team.vercel.app`,
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID_E2E,
    GOOGLE_CLIENT_SECRET: E2E_SECRETS.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL: 'http://127.0.0.1/auth/google/callback',
    JWT_SECRET: E2E_SECRETS.JWT_SECRET,
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '14d',
    LEGACY_ACCESS_TOKEN_CUTOFF: '', // 기본값(프로세스 시작 시각) — auth.e2e-spec이 그 경계를 검사한다
    INJECTIVE_NETWORK: 'testnet',
    INJECTIVE_GRPC_ENDPOINT: '',
    NFT_CONTRACT_ADDRESS: 'inj1e2econtract',
    MASTER_WALLET_MNEMONIC: E2E_SECRETS.MASTER_WALLET_MNEMONIC,
    REWARD_MULTISIG_ADDRESS: 'inj1e2emultisig',
    INJECTIVE_EVM_CHAIN_ID: '1439',
    USDC_EVM_CONTRACT_ADDRESS: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
    PAYOUT_ALLOW_SELF_APPROVAL: 'false', // 2인 규칙 기본값 — 결제 승인은 다른 운영자 세션으로 (bounty-lifecycle approver)
    TURNSTILE_SECRET_KEY: '', // 기본은 봇 방지 꺼짐 — turnstile.e2e-spec만 startApp({ TURNSTILE_SECRET_KEY })로 켠다
  };
}

export type LogLine = { level: string; context: string; message: string };

class CapturingLogger implements LoggerService {
  constructor(readonly lines: LogLine[]) {}
  private push(level: string, message: unknown, rest: unknown[]) {
    const context = typeof rest[rest.length - 1] === 'string' ? String(rest[rest.length - 1]) : '';
    const extra = rest.slice(0, -1).filter((value) => value !== undefined).map((value) => (value instanceof Error ? value.stack : String(value)));
    const text = [message instanceof Error ? message.stack : typeof message === 'string' ? message : JSON.stringify(message), ...extra].join(' ');
    this.lines.push({ level, context, message: text });
    if (process.env.E2E_LOG) process.stdout.write(`[${level}] [${context}] ${text}\n`);
  }
  log(message: unknown, ...rest: unknown[]) { this.push('log', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.push('error', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.push('warn', message, rest); }
  debug(message: unknown, ...rest: unknown[]) { this.push('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]) { this.push('verbose', message, rest); }
  fatal(message: unknown, ...rest: unknown[]) { this.push('fatal', message, rest); }
}

export type HttpResponse<T = any> = { status: number; headers: IncomingHttpHeaders; text: string; body: T };
export type RequestOptions = {
  headers?: Record<string, string>;
  /** JSON 본문 — FE처럼 JSON.stringify(undefined 키는 사라진다) + content-type */
  json?: unknown;
  /** 원시 본문 (multipart 등) */
  body?: Buffer | string;
  /** Bearer 토큰 */
  token?: string;
  /** X-Forwarded-For (기본: 요청마다 무작위 10.x.x.x). null이면 헤더를 보내지 않는다 */
  ip?: string | null;
};

export function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2] || 1}`;
}

export type Session = { accessToken: string; refreshToken: string; userId: string; sub: string; email: string };

export class E2eApp {
  readonly logs: LogLine[] = [];
  readonly google = new FakeGoogle();
  readonly chain = new FakeInjectiveNftClient();
  readonly turnstile = new FakeTurnstile();
  /** close()에서 로그에 나타나지 않아야 하는 값 — 발급된 토큰·키·코드가 자동으로 쌓인다 */
  readonly secrets = new Set<string>(Object.values(E2E_SECRETS));
  app!: NestExpressApplication;
  db!: DatabaseService;
  port = 0;
  private originalFetch = globalThis.fetch;
  private savedEnv: Record<string, string | undefined> = {};

  /** envOverrides: e2eEnv() 위에 덮어쓸 키 (예: TURNSTILE_SECRET_KEY). 값은 시크릿 누출 검사 대상에 들어간다 */
  constructor(private readonly envOverrides: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(envOverrides)) if (/SECRET/.test(key) && value) this.secrets.add(value);
  }

  async start(): Promise<this> {
    for (const [key, value] of Object.entries({ ...e2eEnv(), ...this.envOverrides })) {
      this.savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const google = this.google;
    const turnstile = this.turnstile;
    const passthrough = this.originalFetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return passthrough(input, init);
      if (url === TURNSTILE_SITEVERIFY_URL_E2E) return turnstile.handleFetch(init);
      return google.handleFetch(url, init);
    }) as typeof fetch;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleIdTokenVerifier).useValue(this.google.verifier)
      .overrideProvider(InjectiveNftClient).useValue(this.chain)
      .setLogger(new CapturingLogger(this.logs))
      .compile();
    this.app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(this.app);
    await this.app.listen(0, '127.0.0.1');
    this.port = (this.app.getHttpServer().address() as AddressInfo).port;
    this.db = this.app.get(DatabaseService);
    return this;
  }

  async close(): Promise<void> {
    try {
      this.assertNoSecretsLogged();
    } finally {
      await this.app?.close();
      globalThis.fetch = this.originalFetch;
      for (const [key, value] of Object.entries(this.savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  assertNoSecretsLogged(): void {
    const leaks: string[] = [];
    for (const secret of this.secrets) {
      if (secret.length < 8) continue;
      for (const line of this.logs) {
        if (line.message.includes(secret)) leaks.push(`${secret.slice(0, 10)}… in [${line.context}] ${line.message.slice(0, 200)}`);
      }
    }
    // 니모닉은 단어 일부만 새어도 유출 — 연속 3단어 이상을 찾는다
    const words = E2E_SECRETS.MASTER_WALLET_MNEMONIC.split(' ');
    for (let i = 0; i + 3 <= words.length; i++) {
      const run = words.slice(i, i + 3).join(' ');
      for (const line of this.logs) if (line.message.includes(run)) leaks.push(`mnemonic run "${run}" in ${line.message.slice(0, 200)}`);
    }
    if (leaks.length) throw new Error(`secrets appeared in captured logs:\n${leaks.join('\n')}`);
  }

  linesFor(context: string): string[] {
    return this.logs.filter((line) => line.context === context).map((line) => line.message);
  }

  request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let payload: Buffer | undefined;
    if (options.json !== undefined) {
      payload = Buffer.from(JSON.stringify(options.json));
      headers['content-type'] ??= 'application/json';
    } else if (options.body !== undefined) {
      payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    }
    if (payload) headers['content-length'] = String(payload.length);
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const ip = options.ip === undefined ? randomIp() : options.ip;
    if (ip !== null) headers['x-forwarded-for'] = ip;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let body: any = raw;
          if (/json/.test(String(res.headers['content-type'] ?? ''))) {
            try { body = JSON.parse(text); } catch { body = text; }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get<T = any>(path: string, options?: RequestOptions) { return this.request<T>('GET', path, options); }
  post<T = any>(path: string, json?: unknown, options: RequestOptions = {}) { return this.request<T>('POST', path, { ...options, json }); }
  patch<T = any>(path: string, json?: unknown, options: RequestOptions = {}) { return this.request<T>('PATCH', path, { ...options, json }); }
  delete<T = any>(path: string, options?: RequestOptions) { return this.request<T>('DELETE', path, options); }

  // ── 로그인 (FE auth-adapter + oauth.ts와 같은 순서) ─────────────────────────

  static pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  }

  /** GET /auth/google → (Google) → GET /auth/google/callback. 콜백의 Location을 돌려준다 */
  async oauthCallback(identity: { sub: string; email: string; emailVerified?: boolean }, options: { returnTo?: string; challenge: string; ip?: string; turnstileToken?: string }) {
    const params = new URLSearchParams({ returnTo: options.returnTo ?? FE_ORIGIN, codeChallenge: options.challenge, trace: 'e2e-trace' });
    if (options.turnstileToken) params.set('turnstileToken', options.turnstileToken);
    const start = await this.get(`/auth/google?${params}`, { ip: options.ip });
    if (start.status !== 302) throw new Error(`/auth/google → ${start.status} ${start.text}`);
    const googleUrl = new URL(String(start.headers.location));
    const state = googleUrl.searchParams.get('state')!;
    const code = this.google.issueCode({ sub: identity.sub, email: identity.email, email_verified: identity.emailVerified ?? true });
    const callback = await this.get(`/auth/google/callback?${new URLSearchParams({ code, state, scope: 'openid email' })}`, { ip: options.ip });
    return { googleUrl, state, callback, location: String(callback.headers.location ?? '') };
  }

  /** 전체 로그인 — 세션 토큰과 /auth/me의 id */
  async login(identity: { sub?: string; email?: string } = {}): Promise<Session> {
    const sub = identity.sub ?? `g-${randomBytes(6).toString('hex')}`;
    const email = identity.email ?? `${sub}@example.test`;
    const ip = randomIp();
    const { verifier, challenge } = E2eApp.pkce();
    // 봇 방지가 켜진 앱이면 FE 위젯처럼 토큰을 하나 받아 실어 보낸다
    const turnstileToken = this.envOverrides.TURNSTILE_SECRET_KEY ? this.turnstile.issueToken() : undefined;
    const { location } = await this.oauthCallback({ sub, email }, { challenge, ip, turnstileToken });
    const loginCode = new URLSearchParams(new URL(location).hash.slice(1)).get('loginCode');
    if (!loginCode) throw new Error(`no loginCode in ${location}`);
    this.secrets.add(loginCode);
    this.secrets.add(verifier);
    const exchanged = await this.post('/auth/exchange', { code: loginCode, codeVerifier: verifier }, { ip });
    if (exchanged.status !== 200) throw new Error(`/auth/exchange → ${exchanged.status} ${exchanged.text}`);
    this.trackTokens(exchanged.body);
    const me = await this.get('/auth/me', { token: exchanged.body.accessToken });
    return { ...exchanged.body, userId: me.body.id, sub, email };
  }

  trackTokens(body: { accessToken?: string; refreshToken?: string; apiKey?: string }) {
    for (const value of [body?.accessToken, body?.refreshToken, body?.apiKey]) if (value) this.secrets.add(value);
  }

  /** 운영자 — 로그인 전에 is_admin 유저 행을 만들어 둔다 (JWT의 adm 클레임은 발급 시점 스냅샷) */
  async loginAdmin(): Promise<Session> {
    const sub = `g-admin-${randomBytes(6).toString('hex')}`;
    await this.db.query(
      `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step, is_admin) VALUES ($1, $2, $3, '', 4, true)`,
      [sub, `${sub}@example.test`, `admin_${sub.slice(-8)}`],
    );
    return this.login({ sub, email: `${sub}@example.test` });
  }

  /** 프로필 저장 + 지갑 연결(실제 EIP-191 서명) — payout을 받을 수 있는 빌더 */
  async onboard(session: Session, nickname = `b_${randomBytes(4).toString('hex')}`): Promise<{ nickname: string; signer: HDNodeWallet; walletAddress: string }> {
    const profile = await this.post('/users/me/profile', { nickname, bio: 'builder bio', tags: ['DEV'] }, { token: session.accessToken });
    if (profile.status !== 201) throw new Error(`profile → ${profile.status} ${profile.text}`);
    const signer = Wallet.createRandom();
    const walletAddress = await this.linkWallet(session, signer);
    return { nickname, signer, walletAddress };
  }

  async linkWallet(session: Session, signer: HDNodeWallet): Promise<string> {
    const challenge = await this.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
    if (challenge.status !== 201) throw new Error(`challenge → ${challenge.status} ${challenge.text}`);
    const signature = await signer.signMessage(challenge.body.message);
    const verified = await this.post('/wallets/verify', { address: signer.address, signature }, { token: session.accessToken });
    if (verified.status !== 201) throw new Error(`verify → ${verified.status} ${verified.text}`);
    return verified.body.address;
  }
}

export async function startApp(envOverrides: Record<string, string> = {}): Promise<E2eApp> {
  return new E2eApp(envOverrides).start();
}

/** multipart/form-data 본문 (FE의 FormData → fetch와 같은 모양) */
export function multipart(fields: Array<{ name: string; value: Buffer | string; filename?: string; contentType?: string }>) {
  const boundary = `----e2e${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const field of fields) {
    const disposition = `form-data; name="${field.name}"${field.filename ? `; filename="${field.filename}"` : ''}`;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${field.contentType ? `Content-Type: ${field.contentType}\r\n` : ''}\r\n`));
    parts.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 가장 작은 유효 PNG (1x1) */
export const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f0c3d40000000049454e44ae426082',
  'hex',
);

export const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
export const DAY = 86_400_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const txHash = () => `0x${randomBytes(32).toString('hex')}`;
