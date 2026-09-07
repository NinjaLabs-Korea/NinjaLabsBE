import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const userId = '11111111-1111-4111-8111-111111111111';
const code = 'c'.repeat(43);
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

function setup(query = jest.fn()) {
  const db = { query: jest.fn(), tx: jest.fn(async (run) => run({ query })) };
  const jwt = { signAsync: jest.fn(async () => 'access-token'), verifyAsync: jest.fn() };
  const service = new AuthService(db as never, jwt as never, {} as never);
  return { service, db, jwt };
}

describe('OAuth login handoff', () => {
  it('stores only a code hash, and binds the code to the browser challenge', async () => {
    const { service, db, jwt } = setup();
    const issued = await service.issueLoginCode(userId, challenge);
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.query.mock.calls[1][1]).toEqual([
      createHash('sha256').update(issued).digest('hex'), userId, challenge,
    ]);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('consumes the matching unexpired code and issues a session in one transaction', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: userId, is_admin: false }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const { service, db } = setup(query);
    const tokens = await service.exchangeLoginCode(code, verifier);
    expect(tokens.accessToken).toBe('access-token');
    expect(tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('DELETE FROM oauth_login_code');
    expect(query.mock.calls[0][0]).toContain('c.expires_at > now()');
    expect(query.mock.calls[0][0]).toContain("u.status = 'ACTIVE'");
    expect(query.mock.calls[0][1]).toEqual([createHash('sha256').update(code).digest('hex'), challenge]);
    expect(query.mock.calls[1][1][1]).toBe(createHash('sha256').update(tokens.refreshToken).digest('hex'));
  });

  it.each(['expired', 'already consumed', 'wrong verifier'])('rejects %s codes without issuing tokens', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const { service, jwt } = setup(query);
    await expect(service.exchangeLoginCode(code, verifier)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('allows only one concurrent exchange of a code', async () => {
    let available = true;
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('DELETE')) {
        const first = available;
        available = false;
        return { rowCount: first ? 1 : 0, rows: first ? [{ user_id: userId, is_admin: false }] : [] };
      }
      return { rowCount: 1 };
    });
    const { service, jwt } = setup(query);
    const results = await Promise.allSettled([
      service.exchangeLoginCode(code, verifier), service.exchangeLoginCode(code, verifier),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(jwt.signAsync).toHaveBeenCalledTimes(1);
  });

  it('requires the browser challenge in signed OAuth state', async () => {
    const { service, jwt } = setup();
    await expect(service.issueOauthState(undefined, 'https://app.example', '')).rejects.toBeInstanceOf(UnauthorizedException);
    await service.issueOauthState('trace', 'https://app.example', challenge);
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { p: 'gstate', t: 'trace', r: 'https://app.example', c: challenge }, { expiresIn: '10m' },
    );
    jwt.verifyAsync.mockResolvedValue({ p: 'gstate', c: challenge });
    expect((await service.verifyOauthState('state')).codeChallenge).toBe(challenge);
    jwt.verifyAsync.mockResolvedValue({ p: 'gstate' });
    await expect(service.verifyOauthState('legacy-state')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('redirects with only a login code, never access or refresh tokens', async () => {
    const auth = {
      verifyOauthState: jest.fn(async () => ({ codeChallenge: challenge })),
      exchangeGoogleCode: jest.fn(async () => ({ googleId: 'google', email: 'test@example.com' })),
      upsertGoogleUser: jest.fn(async () => ({ id: userId, onboarding_step: 2, onboarding_completed_at: null })),
      issueLoginCode: jest.fn(async () => code),
      issueSession: jest.fn(),
    };
    const controller = new AuthController(auth as never, { get: () => 'https://app.example/' } as never);
    const res = { redirect: jest.fn() };
    await controller.googleCallback('google-code', 'state', undefined, { headers: {} } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith(`https://app.example/auth/callback#loginCode=${code}`);
    expect(auth.issueSession).not.toHaveBeenCalled();
  });
});
