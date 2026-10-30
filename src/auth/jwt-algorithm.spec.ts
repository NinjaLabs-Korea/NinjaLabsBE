import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import { AccessTokenVerifier } from './access-token.verifier';
import { AuthSessions } from './auth-sessions';
import { GoogleOAuthFlow } from './google-oauth.flow';
import { DEFAULT_EXCLUDE, listSourceFiles } from '../test-support/source-files';
import { JWT_ALGORITHM } from './jwt-algorithm';

const SECRET = 'jwt-algorithm-spec-secret-0123456789abcdef';
const CHALLENGE = 'A'.repeat(43);

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** header.payload.signature with an arbitrary `alg` header; HS* algorithms are signed with the real secret so only the algorithm check can reject them */
function forge(alg: string, payload: object, secret = SECRET): string {
  const signingInput = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  const hash = alg.startsWith('HS') ? `sha${alg.slice(2)}` : undefined;
  const signature = hash ? createHmac(hash, secret).update(signingInput).digest('base64url') : '';
  return `${signingInput}.${signature}`;
}
const header = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as { alg: string };
const exp = () => Math.floor(Date.now() / 1000) + 600;

describe('JWT algorithm pinning', () => {
  // deliberately a bare JwtService (no module-level sign/verify options): the pin must come from the call sites themselves
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS512' } });
  const accessPayload = { sub: 'user-1', adm: false, typ: 'access', exp: exp() };
  const statePayload = { p: 'gstate', c: CHALLENGE, r: 'https://app.example/', exp: exp() };
  const verifier = new AccessTokenVerifier(jwt, Date.now());
  const flow = new GoogleOAuthFlow(jwt, { get: jest.fn() } as never, {} as never, new Logger('test'));

  it('accepts an HS256 access token and OAuth state', async () => {
    await expect(verifier.verify(forge('HS256', accessPayload))).resolves.toEqual({ userId: 'user-1', isAdmin: false });
    await expect(flow.verifyOauthState(forge('HS256', statePayload))).resolves.toMatchObject({ codeChallenge: CHALLENGE });
  });

  it.each(['HS384', 'HS512', 'none'])('rejects an access token signed with %s', async (alg) => {
    await expect(verifier.verify(forge(alg, accessPayload))).rejects.toMatchObject({ status: 401, message: 'INVALID_ACCESS_TOKEN' });
  });

  it.each(['HS384', 'HS512', 'none'])('rejects an OAuth state signed with %s', async (alg) => {
    await expect(flow.verifyOauthState(forge(alg, statePayload))).rejects.toMatchObject({ status: 401, message: 'INVALID_OAUTH_STATE' });
  });

  it('rejects an unsigned token', async () => {
    const noSignature = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(accessPayload)}.`;
    await expect(verifier.verify(noSignature)).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
  });

  it('signs the OAuth state and the access token with HS256 even when the JwtService default is another algorithm', async () => {
    expect(header(await flow.issueOauthState(undefined, 'https://app.example/', CHALLENGE)).alg).toBe(JWT_ALGORITHM);
    const sessions = new AuthSessions({} as never, jwt, '14 days', SECRET, new Logger('test')) as unknown as { signAccessToken(userId: string, isAdmin: boolean): Promise<string> };
    const access = await sessions.signAccessToken('user-1', false);
    expect(header(access).alg).toBe('HS256');
    await expect(verifier.verify(access)).resolves.toEqual({ userId: 'user-1', isAdmin: false });
  });

  it('every signAsync/verifyAsync/sign/verify call in src passes the algorithm options (nobody forgets the pin on a new path)', () => {
    // test-db, test-e2e, test-support 폴더는 운영 코드가 아니라 뺀다 (기본 규칙에 폴더 제외만 더한다)
    const files = listSourceFiles(join(__dirname, '..'), { exclude: new RegExp(`${DEFAULT_EXCLUDE.source}|(?:^|/)test-[^/]+/`) });
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/\b(?:jwt|jwtService)\.(?:signAsync|verifyAsync|sign|verify)\([\s\S]*?\)\s*[;,)]/g) ?? [];
      for (const call of calls) {
        if (!/JWT_SIGN_OPTIONS|JWT_VERIFY_OPTIONS/.test(call)) offenders.push(`${file}: ${call.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
