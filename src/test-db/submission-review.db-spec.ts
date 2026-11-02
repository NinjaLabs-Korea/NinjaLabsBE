import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser, testConfig, unique } from './harness';

/**
 * 제출 심사 규칙을 실 Postgres 행으로 단언한다 (submission-review.service.spec.ts의 옛 SQL 해석 mock 대체):
 * 상태 x 결정 표, 바운티 상태, 리비전 가드, 코멘트 규칙, max_winners, 제출자 계정 잠금, 리뷰 행이 가리키는 리비전, 감사 행.
 * 승인과 탈퇴의 경합은 withdrawal.db-spec.ts, 리비전 흐름은 bounty-rules.db-spec.ts가 이미 다룬다.
 */
describeDb('submission review on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let submissions: SubmissionsService;
  let review: SubmissionReviewService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(testConfig()));
    submissions = new SubmissionsService(db, new AuditService(db));
    review = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  async function bountyIn(options: { status?: string; maxWinners?: number; mode?: 'DIRECT' | 'AGENT' } = {}) {
    const { id } = await bounties.create(adminId, {
      title: unique('rev-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode: options.mode ?? 'DIRECT', maxWinners: options.maxWinners ?? 3,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await db.query(`UPDATE bounty SET status = $2 WHERE id = $1`, [id, options.status ?? 'OPEN']);
    return id;
  }
  async function submitted(bountyId: string, status = 'SUBMITTED') {
    const user = await createUser(db);
    const sub = await submissions.submit(bountyId, user, { submissionUrl: `https://x.test/${unique()}`, description: 'work' });
    if (status !== 'SUBMITTED') await db.query(`UPDATE bounty_submission SET status = $2 WHERE id = $1`, [sub.id, status]);
    return { id: sub.id, user };
  }
  const statusOf = async (id: string) =>
    (await db.query<{ status: string; reviewed_at: Date | null }>(`SELECT status, reviewed_at FROM bounty_submission WHERE id = $1`, [id])).rows[0];
  const reviewRows = async (id: string) =>
    (await db.query<{ decision: string; comment: string | null; reviewer_id: string; revision_no: number | null }>(
      `SELECT v.decision, v.comment, v.reviewer_id, r.revision_no FROM submission_review v LEFT JOIN submission_revision r ON r.id = v.revision_id WHERE v.submission_id = $1 ORDER BY v.created_at, v.id`, [id])).rows;

  it.each([
    ['START_REVIEW', 'IN_REVIEW'],
    ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['APPROVE', 'APPROVED'],
    ['REJECT', 'REJECTED'],
  ])('%s moves a SUBMITTED submission to %s: row status + reviewed_at, one review row for the current revision, the reviewer, the audit entry', async (decision, status) => {
    const bountyId = await bountyIn();
    const { id } = await submitted(bountyId);
    await expect(review.review(id, decision, 'note', adminId, 1)).resolves.toEqual({ id, status });
    expect(await statusOf(id)).toMatchObject({ status });
    expect((await statusOf(id)).reviewed_at).toBeInstanceOf(Date);
    expect(await reviewRows(id)).toEqual([{ decision, comment: 'note', reviewer_id: adminId, revision_no: 1 }]);
    expect(await auditActions(db, 'bounty_submission', id)).toContain(`SUBMISSION_${decision}`);
  });

  it('a blank comment is stored as NULL and a padded one trimmed', async () => {
    const bountyId = await bountyIn();
    const a = await submitted(bountyId);
    const b = await submitted(bountyId);
    await review.review(a.id, 'APPROVE', '  \n ', adminId);
    await review.review(b.id, 'APPROVE', '  nice work ', adminId);
    expect((await reviewRows(a.id))[0].comment).toBeNull();
    expect((await reviewRows(b.id))[0].comment).toBe('nice work');
  });

  it('a submission or bounty that does not exist (unknown id, soft-deleted bounty) is 404 SUBMISSION_NOT_FOUND', async () => {
    await expect(review.review('00000000-0000-4000-8000-000000000000', 'REJECT', 'x', adminId)).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
    const bountyId = await bountyIn();
    const { id } = await submitted(bountyId);
    await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [bountyId]);
    await expect(review.review(id, 'REJECT', 'x', adminId)).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
    expect(await statusOf(id)).toMatchObject({ status: 'SUBMITTED', reviewed_at: null });
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('no review on a %s bounty (400 BOUNTY_REVIEW_CLOSED, nothing written)', async (bountyStatus) => {
    const bountyId = await bountyIn();
    const { id } = await submitted(bountyId);
    await db.query(`UPDATE bounty SET status = $2 WHERE id = $1`, [bountyId, bountyStatus]);
    await expect(review.review(id, 'REJECT', 'x', adminId)).rejects.toMatchObject({ status: 400, message: 'BOUNTY_REVIEW_CLOSED' });
    expect(await statusOf(id)).toMatchObject({ status: 'SUBMITTED' });
    expect(await reviewRows(id)).toEqual([]);
  });

  it.each(['OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW'])('reviews are allowed while the bounty is %s', async (bountyStatus) => {
    const bountyId = await bountyIn();
    const { id } = await submitted(bountyId);
    await db.query(`UPDATE bounty SET status = $2 WHERE id = $1`, [bountyId, bountyStatus]);
    await expect(review.review(id, 'START_REVIEW', undefined, adminId)).resolves.toEqual({ id, status: 'IN_REVIEW' });
  });

  // status x decision: REVISION_REQUESTED only accepts REJECT (closing an abandoned revision); IN_REVIEW cannot start again; finals take nothing
  const DECISIONS = ['START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT'];
  const matrix: Array<[string, string, boolean]> = [];
  for (const status of ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW']) for (const d of DECISIONS) matrix.push([status, d, !(status === 'IN_REVIEW' && d === 'START_REVIEW')]);
  for (const d of DECISIONS) matrix.push(['REVISION_REQUESTED', d, d === 'REJECT']);
  for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN']) for (const d of DECISIONS) matrix.push([status, d, false]);

  it.each(matrix)('submission %s + %s -> reviewable=%s', async (status, decision, reviewable) => {
    const bountyId = await bountyIn({ maxWinners: 5 });
    const { id } = await submitted(bountyId, status);
    const outcome = await review.review(id, decision, 'feedback', adminId, 1).then(() => 'ok', (err: Error) => err.message);
    if (reviewable) {
      expect(outcome).toBe('ok');
      expect((await reviewRows(id)).map((r) => r.decision)).toEqual([decision]);
    } else {
      expect(outcome).toBe('SUBMISSION_NOT_REVIEWABLE');
      expect(await statusOf(id)).toMatchObject({ status });
      expect(await reviewRows(id)).toEqual([]);
    }
  });

  it('revisionNo omitted reviews whatever is current; a stale revisionNo (older or newer than current) is 400 SUBMISSION_REVISION_CHANGED with nothing written', async () => {
    const bountyId = await bountyIn();
    const { id, user } = await submitted(bountyId);
    await submissions.submit(bountyId, user, { submissionUrl: 'https://x.test/v2', description: 'v2' }); // current revision 2
    for (const seen of [1, 3]) {
      await expect(review.review(id, 'APPROVE', undefined, adminId, seen)).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_REVISION_CHANGED' });
    }
    expect(await statusOf(id)).toMatchObject({ status: 'RESUBMITTED' });
    expect(await reviewRows(id)).toEqual([]);

    await expect(review.review(id, 'APPROVE', undefined, adminId)).resolves.toEqual({ id, status: 'APPROVED' });
    expect(await reviewRows(id)).toEqual([{ decision: 'APPROVE', comment: null, reviewer_id: adminId, revision_no: 2 }]); // pinned to the revision it judged
  });

  it.each([undefined, '', '   \n\t'])('REQUEST_REVISION needs actionable feedback (comment %p -> 400 REVISION_COMMENT_REQUIRED, nothing written)', async (comment) => {
    const { id } = await submitted(await bountyIn());
    await expect(review.review(id, 'REQUEST_REVISION', comment, adminId)).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    expect(await statusOf(id)).toMatchObject({ status: 'SUBMITTED' });
    expect(await reviewRows(id)).toEqual([]);
  });

  it('rejecting an abandoned revision request also needs a comment; rejecting a fresh submission does not', async () => {
    const bountyId = await bountyIn();
    const abandoned = await submitted(bountyId, 'REVISION_REQUESTED');
    await expect(review.review(abandoned.id, 'REJECT', ' ', adminId, 1)).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    expect(await statusOf(abandoned.id)).toMatchObject({ status: 'REVISION_REQUESTED' });
    await expect(review.review(abandoned.id, 'REJECT', 'abandoned', adminId, 1)).resolves.toEqual({ id: abandoned.id, status: 'REJECTED' });
    const fresh = await submitted(bountyId);
    await expect(review.review(fresh.id, 'REJECT', undefined, adminId)).resolves.toEqual({ id: fresh.id, status: 'REJECTED' });
  });

  it('a legacy submission without a revision snapshot is still reviewed, with revision_id NULL', async () => {
    const { id } = await submitted(await bountyIn());
    await db.query(`DELETE FROM submission_revision WHERE submission_id = $1`, [id]);
    await review.review(id, 'START_REVIEW', undefined, adminId);
    expect(await reviewRows(id)).toEqual([{ decision: 'START_REVIEW', comment: null, reviewer_id: adminId, revision_no: null }]);
  });

  it.each([[1, 0, true], [1, 1, false], [3, 2, true], [3, 3, false]])(
    'max_winners %i with %i already approved -> approving allowed=%s (other bounties\' winners do not count)',
    async (maxWinners, approved, allowed) => {
      const bountyId = await bountyIn({ maxWinners });
      for (let i = 0; i < approved; i++) await submitted(bountyId, 'APPROVED');
      const otherBounty = await bountyIn({ maxWinners: 1 });
      await submitted(otherBounty, 'APPROVED');
      const { id } = await submitted(bountyId);
      const outcome = await review.review(id, 'APPROVE', undefined, adminId).then(() => 'ok', (err: Error) => err.message);
      expect(outcome).toBe(allowed ? 'ok' : 'MAX_WINNERS_REACHED');
      expect((await statusOf(id)).status).toBe(allowed ? 'APPROVED' : 'SUBMITTED');
    },
  );

  it.each(['START_REVIEW', 'REQUEST_REVISION', 'REJECT'])('%s is not counted against max_winners even when the cap is reached', async (decision) => {
    const bountyId = await bountyIn({ maxWinners: 1 });
    await submitted(bountyId, 'APPROVED');
    const { id } = await submitted(bountyId);
    await expect(review.review(id, decision, 'fix it', adminId)).resolves.toMatchObject({ id });
  });

  it('only APPROVED counts as a winner: rejected, withdrawn and in-review submissions do not use up the cap', async () => {
    const bountyId = await bountyIn({ maxWinners: 1 });
    for (const status of ['REJECTED', 'WITHDRAWN', 'IN_REVIEW', 'REVISION_REQUESTED']) await submitted(bountyId, status);
    const { id } = await submitted(bountyId);
    await expect(review.review(id, 'APPROVE', undefined, adminId)).resolves.toEqual({ id, status: 'APPROVED' });
  });

  it('APPROVE needs an active submitter (a person or the agent\'s owner): suspended or soft-deleted owner is 404 USER_NOT_FOUND; the other decisions still work', async () => {
    const bountyId = await bountyIn();
    for (const makeInactive of [
      `UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`,
      `UPDATE "user" SET deleted_at = now() WHERE id = $1`,
    ]) {
      const person = await submitted(bountyId);
      await db.query(makeInactive, [person.user]);
      await expect(review.review(person.id, 'APPROVE', undefined, adminId)).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
      expect(await statusOf(person.id)).toMatchObject({ status: 'SUBMITTED' });
      expect(await reviewRows(person.id)).toEqual([]);
      await expect(review.review(person.id, 'REJECT', undefined, adminId)).resolves.toEqual({ id: person.id, status: 'REJECTED' });
    }

    // an agent submission follows its owner
    const owner = await createUser(db);
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at) VALUES ($1, 'bot', $2, $3, 'ACTIVE', now()) RETURNING id`,
      [owner, unique('pk-'), `0x${unique()}`]);
    const agentBounty = await bountyIn({ mode: 'AGENT' });
    const viaAgent = await submissions.submitAsAgent(agentBounty, agent.rows[0].id, { submissionUrl: 'https://x.test/a', description: 'd' });
    await db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [owner]);
    await expect(review.review(viaAgent.id, 'APPROVE', undefined, adminId)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
  });
});
