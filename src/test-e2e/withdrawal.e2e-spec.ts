import { describeDb } from '../test-db/describe-db';
import { E2eApp, startApp } from './support/harness';

// DELETE /users/me — FE /account danger zone: confirm nickname → withdraw → POST /auth/logout → home
describeDb('account withdrawal over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  it('validates the body, rejects a wrong nickname, withdraws, kills the session, hides the profile, and lets the same Google account sign up again', async () => {
    const session = await e2e.login();
    const { nickname } = await e2e.onboard(session);
    const withdraw = (json: unknown, token: string | null = session.accessToken) =>
      e2e.request('DELETE', '/users/me', { json, token: token ?? undefined });

    expect((await withdraw({ confirmNickname: nickname }, null)).status).toBe(401);
    const empty = await withdraw({});
    expect(empty.status).toBe(400);
    const wrong = await withdraw({ confirmNickname: `${nickname}x` });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('CONFIRM_NICKNAME_MISMATCH');
    expect((await e2e.get(`/users/${nickname}`)).status).toBe(200);

    const ok = await withdraw({ confirmNickname: nickname.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });

    // same process → status cache forgotten → the access token stops working at once; refresh is revoked
    expect((await e2e.get('/auth/me', { token: session.accessToken })).status).toBe(401);
    expect((await e2e.post('/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(401);
    // the FE's follow-up logout still answers 204 (idempotent) so the cookie can be cleared
    expect((await e2e.post('/auth/logout', { refreshToken: session.refreshToken })).status).toBe(204);
    expect((await e2e.get(`/users/${nickname}`)).status).toBe(404);

    const again = await e2e.login({ sub: session.sub, email: session.email });
    expect(again.userId).not.toBe(session.userId);
    const me = await e2e.get('/auth/me', { token: again.accessToken });
    expect(me.body).toMatchObject({ onboardingStep: 2, wallet: null });
  });
});
