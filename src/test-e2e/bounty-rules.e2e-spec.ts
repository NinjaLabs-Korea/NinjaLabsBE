import { describeDb } from '../test-db/describe-db';
import { AdminBountyForm, applyBody, saveAdminBountyBody, submitBody } from './support/fe-payloads';
import { DAY, E2eApp, isoIn, Session, startApp, txHash } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

function bountyForm(overrides: Partial<AdminBountyForm> = {}): AdminBountyForm {
  return {
    slug: '', title: `E2E rules ${Date.now().toString(36)}`, sponsor: 'Injective Labs',
    description: 'Build a widget. '.repeat(30), requirements: '- a repo', reviewProcess: 'Judged by the core team',
    tags: ['Dev'], intakeEnabled: false, maxWinners: 1, submissionMode: 'direct', coverImage: null,
    deadline: isoIn(14 * DAY), reward: { amount: 0, currency: 'INJ' }, ...overrides,
  };
}

// revision flow, cancellation and review-input validation over HTTP — status codes and error codes as the FE sees them
describeDb('bounty rules over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  let approver: Session;
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
    approver = await e2e.loginAdmin();
  });
  afterAll(async () => e2e?.close());

  const asAdmin = { get token() { return admin.accessToken; } };
  const asApprover = { get token() { return approver.accessToken; } };
  async function createBounty(form: AdminBountyForm): Promise<string> {
    const res = await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), asAdmin);
    expect(res.status).toBe(201);
    return res.body.id;
  }
  const transition = (id: string, to: string) => e2e.post(`/admin/bounties/${id}/transition`, { to }, asAdmin);
  const review = (submissionId: string, body: Record<string, unknown>) => e2e.post(`/admin/submissions/${submissionId}/review`, body, asAdmin);
  const submit = (bountyId: string, user: Session, n: number | string) =>
    e2e.post(`/bounties/${bountyId}/submissions`, submitBody({ submissionUrl: `https://demo.example/r${n}`, description: `rev ${n}` }), { token: user.accessToken });
  const expireDeadline = (id: string) => e2e.db.query(`UPDATE bounty SET submission_deadline = now() - interval '1 minute' WHERE id = $1`, [id]);

  it('revision flow: requested revision may be delivered after the deadline (once), everything else is DEADLINE_PASSED / BOUNTY_NOT_OPEN; reviews pin revisions', async () => {
    const id = await createBounty(bountyForm({ maxWinners: 2 }));
    expect((await transition(id, 'OPEN')).body).toEqual({ id, status: 'OPEN' });
    const builder = await e2e.login();
    const late = await e2e.login();

    const first = await submit(id, builder, 1);
    expect(first.status).toBe(201);
    const submissionId: string = first.body.id;
    expect((await review(submissionId, { decision: 'START_REVIEW', revisionNo: 1 })).body).toEqual({ id: submissionId, status: 'IN_REVIEW' });
    expect((await review(submissionId, { decision: 'REQUEST_REVISION', revisionNo: 1 })).body).toEqual(badRequest('REVISION_COMMENT_REQUIRED'));
    const requested = await review(submissionId, { decision: 'REQUEST_REVISION', revisionNo: 1, comment: 'Add a demo video' });
    expect(requested.status).toBe(201);
    expect(requested.body).toEqual({ id: submissionId, status: 'REVISION_REQUESTED' });
    expect((await e2e.get('/submissions/me', { token: builder.accessToken })).body)
      .toEqual([expect.objectContaining({ id: submissionId, status: 'REVISION_REQUESTED', review_comment: 'Add a demo video', current_revision_no: 1, payment_status: 'NONE' })]);

    await expireDeadline(id);
    expect((await submit(id, late, 'late')).body).toEqual(badRequest('DEADLINE_PASSED')); // a first submission after the deadline
    const revised = await submit(id, builder, 2);
    expect(revised.status).toBe(201);
    expect(revised.body).toEqual({ id: submissionId, revisionNo: 2, status: 'RESUBMITTED' });
    expect((await submit(id, builder, 3)).body).toEqual(badRequest('DEADLINE_PASSED')); // the request was answered

    expect((await transition(id, 'SUBMISSION_CLOSED')).body).toEqual({ id, status: 'SUBMISSION_CLOSED' });
    expect((await transition(id, 'OPEN')).body).toEqual(badRequest(['Extend the submission deadline before opening this bounty.']));
    expect((await review(submissionId, { decision: 'APPROVE', revisionNo: 1 })).body).toEqual(badRequest('SUBMISSION_REVISION_CHANGED'));
    expect((await review(submissionId, { decision: 'APPROVE', revisionNo: 2, comment: 'Great demo' })).body).toEqual({ id: submissionId, status: 'APPROVED' });
    expect((await review(submissionId, { decision: 'REJECT', comment: 'oops' })).body).toEqual(badRequest('SUBMISSION_NOT_REVIEWABLE'));

    const ops = await e2e.get(`/admin/bounties/${id}/operations`, asAdmin);
    const sub = ops.body.submissions.find((s: { id: string }) => s.id === submissionId);
    expect(sub.revisions.map((r: { revision_no: number; submission_url: string }) => [r.revision_no, r.submission_url]))
      .toEqual([[2, 'https://demo.example/r2'], [1, 'https://demo.example/r1']]);
    expect(sub.reviews.map((r: { revision_no: number; decision: string }) => [r.revision_no, r.decision]))
      .toEqual([[2, 'APPROVE'], [1, 'REQUEST_REVISION'], [1, 'START_REVIEW']]);
    expect(sub.review_comment).toBe('Great demo');

    expect((await transition(id, 'IN_REVIEW')).body).toEqual({ id, status: 'IN_REVIEW' });
    expect((await transition(id, 'COMPLETED')).body).toEqual({ id, status: 'COMPLETED' });
    expect((await transition(id, 'OPEN')).body).toEqual(badRequest('INVALID_TRANSITION:COMPLETED->OPEN'));
    expect((await review(submissionId, { decision: 'START_REVIEW' })).body).toEqual(badRequest('BOUNTY_REVIEW_CLOSED'));
  });

  it('cancelling an OPEN funded bounty closes participation, reviews and payouts, and the held deposit still blocks deletion', async () => {
    const id = await createBounty(bountyForm({ reward: { amount: 1, currency: 'INJ' } }));
    const rewardId: string = (await e2e.get(`/admin/bounties/${id}/operations`, asAdmin)).body.rewards[0].id;
    expect((await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: txHash(), depositedAmount: '1000000000000000000' }, asAdmin)).status).toBe(201);
    expect((await transition(id, 'OPEN')).body.status).toBe('OPEN');
    const winner = await e2e.login();
    await e2e.onboard(winner);
    // left unreviewed — an approved winner still owed would block the cancel (UNPAID_WINNERS, bounty-lifecycle e2e)
    const sub = await submit(id, winner, 'w');

    expect((await transition(id, 'CANCELLED')).body).toEqual({ id, status: 'CANCELLED' });
    expect((await submit(id, await e2e.login(), 'x')).body).toEqual(badRequest('BOUNTY_NOT_OPEN'));
    expect((await review(sub.body.id, { decision: 'APPROVE' })).body).toEqual(badRequest('BOUNTY_REVIEW_CLOSED'));
    const payout = await e2e.post('/admin/payouts', { rewardId, submissionId: sub.body.id, amount: '1000000000000000000' }, asAdmin);
    expect(payout.body).toEqual(badRequest('BOUNTY_REVIEW_CLOSED'));
    expect((await e2e.delete(`/admin/bounties/${id}`, asAdmin)).body).toEqual({ statusCode: 409, error: 'Conflict', message: 'BOUNTY_HAS_OPEN_FUNDS' });
    for (const to of ['OPEN', 'COMPLETED', 'DRAFT']) {
      expect((await transition(id, to)).body).toEqual(badRequest(`INVALID_TRANSITION:CANCELLED->${to}`));
    }
    // still publicly visible as CANCELLED (only DRAFT/FUNDING_PENDING are hidden)
    expect((await e2e.get(`/bounties/${id}`)).body).toMatchObject({ id, status: 'CANCELLED' });
  });

  it('application review over HTTP: approval closes with intake, rejection stays possible, finished applications are 404', async () => {
    const id = await createBounty(bountyForm({ intakeEnabled: true }));
    expect((await transition(id, 'OPEN')).body.status).toBe('OPEN');
    const [a, b] = [await e2e.login(), await e2e.login()];
    const appA = await e2e.post(`/bounties/${id}/applications`, applyBody('A'), { token: a.accessToken });
    const appB = await e2e.post(`/bounties/${id}/applications`, applyBody('B'), { token: b.accessToken });
    expect((await e2e.post(`/applications/${appA.body.id}/withdraw`, undefined, { token: b.accessToken })).body)
      .toEqual({ statusCode: 404, error: 'Not Found', message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' }); // not B's application

    await expireDeadline(id);
    expect((await e2e.post(`/admin/applications/${appA.body.id}/review`, { decision: 'APPROVED' }, asAdmin)).body).toEqual(badRequest('APPLICATION_APPROVAL_CLOSED'));
    const rejected = await e2e.post(`/admin/applications/${appA.body.id}/review`, { decision: 'REJECTED', note: '  intake ended  ' }, asAdmin);
    expect(rejected.status).toBe(201);
    expect(rejected.body).toEqual({ id: appA.body.id, status: 'REJECTED' });
    expect((await e2e.get('/applications/me', { token: a.accessToken })).body).toEqual([expect.objectContaining({ id: appA.body.id, status: 'REJECTED', review_note: 'intake ended' })]);
    expect((await e2e.post(`/admin/applications/${appA.body.id}/review`, { decision: 'REJECTED' }, asApprover)).body)
      .toEqual({ statusCode: 404, error: 'Not Found', message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });

    // the pending one still blocks closing even after the deadline; rejecting it unblocks
    expect((await transition(id, 'SUBMISSION_CLOSED')).body).toEqual(badRequest(['Review 1 pending application(s) before closing submissions.']));
    await e2e.post(`/admin/applications/${appB.body.id}/review`, { decision: 'REJECTED' }, asAdmin);
    expect((await transition(id, 'SUBMISSION_CLOSED')).body).toEqual({ id, status: 'SUBMISSION_CLOSED' });
  });

  it('review and transition inputs are validated before any service code (400 with the validator message)', async () => {
    const id = await createBounty(bountyForm());
    const anyId = '00000000-0000-4000-8000-000000000000';
    const bad = await review(anyId, { decision: 'MAYBE' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toEqual(['decision must be one of the following values: START_REVIEW, REQUEST_REVISION, APPROVE, REJECT']);
    expect((await review(anyId, { decision: 'APPROVE', revisionNo: 0 })).body.message).toEqual(['revisionNo must not be less than 1']);
    expect((await e2e.post(`/admin/applications/${anyId}/review`, { decision: 'PENDING' }, asAdmin)).body.message)
      .toEqual(['decision must be one of the following values: APPROVED, REJECTED']);
    expect((await transition(id, 'ARCHIVED')).body.message).toEqual([expect.stringMatching(/^to must be one of the following values: /)]);
    // a well-formed review of an unknown submission is a 404 from the service
    expect((await review(anyId, { decision: 'APPROVE' })).body).toEqual({ statusCode: 404, error: 'Not Found', message: 'SUBMISSION_NOT_FOUND' });
    expect((await e2e.post(`/admin/payouts/${anyId}/approve`, undefined, asApprover)).body)
      .toEqual({ statusCode: 404, error: 'Not Found', message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
  });
});
