import { describeDb } from '../test-db/describe-db';
import { AdminBountyForm, applyBody, saveAdminBountyBody, submitBody } from './support/fe-payloads';
import { DAY, E2eApp, isoIn, startApp, txHash } from './support/harness';

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

  it('an approved winner whose funded reward has not been requested yet gets 409 WITHDRAWAL_BLOCKED_PENDING_REWARDS until it is paid', async () => {
    const admin = await e2e.loginAdmin();
    const approver = await e2e.loginAdmin();
    const asAdmin = { token: admin.accessToken };
    const builder = await e2e.login();
    const { nickname } = await e2e.onboard(builder);
    const withdraw = () => e2e.request('DELETE', '/users/me', { json: { confirmNickname: nickname }, token: builder.accessToken });

    const form: AdminBountyForm = {
      slug: '', title: `E2E withdrawal ${Date.now().toString(36)}`, sponsor: 'Injective Labs',
      description: 'Build a widget. '.repeat(30), requirements: '- a repo', reviewProcess: 'Judged by the core team',
      tags: ['Dev'], intakeEnabled: true, maxWinners: 1, submissionMode: 'direct', coverImage: null,
      deadline: isoIn(14 * DAY), reward: { amount: 100, currency: 'INJ' },
    };
    const bountyId: string = (await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), asAdmin)).body.id;
    const rewardId: string = (await e2e.get(`/admin/bounties/${bountyId}/operations`, asAdmin)).body.rewards[0].id;
    expect((await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: txHash(), depositedAmount: '100000000000000000000' }, asAdmin)).status).toBe(201);
    expect((await e2e.post(`/admin/bounties/${bountyId}/transition`, { to: 'OPEN' }, asAdmin)).body).toEqual({ id: bountyId, status: 'OPEN' });
    const applicationId: string = (await e2e.post(`/bounties/${bountyId}/applications`, applyBody('I will build it'), { token: builder.accessToken })).body.id;
    await e2e.post(`/admin/applications/${applicationId}/review`, { decision: 'APPROVED' }, asAdmin);
    const submissionId: string = (await e2e.post(`/bounties/${bountyId}/submissions`, submitBody({ submissionUrl: 'https://demo.example/w', description: 'work' }), { token: builder.accessToken })).body.id;
    expect((await e2e.post(`/admin/submissions/${submissionId}/review`, { decision: 'APPROVE', revisionNo: 1 }, asAdmin)).body).toEqual({ id: submissionId, status: 'APPROVED' });

    const blocked = await withdraw();
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ statusCode: 409, error: 'Conflict', message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
    expect((await e2e.get('/auth/me', { token: builder.accessToken })).status).toBe(200); // nothing changed

    const payoutId: string = (await e2e.post('/admin/payouts', { rewardId, submissionId, amount: '100000000000000000000' }, asAdmin)).body.id;
    expect((await withdraw()).body.message).toBe('WITHDRAWAL_BLOCKED_OPEN_PAYOUTS');
    expect((await e2e.post(`/admin/payouts/${payoutId}/approve`, undefined, { token: approver.accessToken })).body).toEqual({ id: payoutId, status: 'APPROVED' });
    expect((await e2e.post(`/admin/payouts/${payoutId}/paid`, { txHash: txHash() }, asAdmin)).status).toBe(201);

    const ok = await withdraw();
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });
});
