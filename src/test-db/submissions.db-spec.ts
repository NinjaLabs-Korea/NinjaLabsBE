import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique, withPayoutAddresses } from './harness';

/**
 * 제출 규칙을 실 Postgres 행으로 단언한다 (submissions.service.spec.ts의 옛 SQL 해석 mock 대체):
 * 바운티 상태 x 마감 x 기존 제출 상태 표, 지원형 연결, 제출 방식(사람/에이전트), 리비전 스냅샷, 내 제출 내역 쿼리.
 */
describeDb('submission rules on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = withPayoutAddresses(db, new RewardsService(db, audit, config));
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db, new AuditService(db));
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
  const PAST = () => new Date(Date.now() - 60_000).toISOString();
  const work = (n: number | string) => ({ submissionUrl: `https://x.test/work/${n}`, description: `revision ${n}` });

  /** 보상 없는 바운티를 만들고 상태·마감을 직접 맞춘다 (상태 표를 한 줄로 세우기 위해) */
  async function bountyIn(options: { status?: string; deadline?: string; applicationRequired?: boolean; mode?: 'DIRECT' | 'AGENT' } = {}) {
    const { id } = await bounties.create(adminId, {
      title: unique('sub-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: options.applicationRequired ?? false, submissionMode: options.mode ?? 'DIRECT', maxWinners: 1,
      submissionDeadline: FUTURE(),
    });
    await db.query(`UPDATE bounty SET status = $2, submission_deadline = $3 WHERE id = $1`, [id, options.status ?? 'OPEN', options.deadline ?? FUTURE()]);
    return id;
  }
  async function agentOf(ownerId: string, name = 'bot') {
    const r = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now()) RETURNING id`,
      [ownerId, name, unique('pk-'), `0x${unique()}`],
    );
    return r.rows[0].id;
  }
  const countRows = async (bountyId: string) => {
    const s = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty_submission WHERE bounty_id = $1`, [bountyId]);
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM submission_revision v JOIN bounty_submission s ON s.id = v.submission_id WHERE s.bounty_id = $1`, [bountyId]);
    return { submissions: s.rows[0].n, revisions: r.rows[0].n };
  };
  const submissionRow = async (id: string) =>
    (await db.query(`SELECT status, current_revision_no, submission_url, description, repository_url, commit_sha, last_resubmitted_at FROM bounty_submission WHERE id = $1`, [id])).rows[0];

  it('404 BOUNTY_NOT_FOUND for an unknown or soft-deleted bounty', async () => {
    const user = await createUser(db);
    await expect(submissions.submit('00000000-0000-4000-8000-000000000000', user, work(1))).rejects.toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
    const deleted = await bountyIn();
    await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [deleted]);
    await expect(submissions.submit(deleted, user, work(1))).rejects.toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('a %s bounty takes no submission or revision (400 BOUNTY_NOT_OPEN) and writes nothing', async (status) => {
    const user = await createUser(db);
    const bountyId = await bountyIn();
    const first = await submissions.submit(bountyId, user, work(1));
    await db.query(`UPDATE bounty_submission SET status = 'REVISION_REQUESTED' WHERE id = $1`, [first.id]);
    await db.query(`UPDATE bounty SET status = $2 WHERE id = $1`, [bountyId, status]);
    const before = await countRows(bountyId);

    await expect(submissions.submit(bountyId, user, work(2))).rejects.toMatchObject({ status: 400, message: 'BOUNTY_NOT_OPEN' });
    await expect(submissions.submit(bountyId, await createUser(db), work(3))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect(await countRows(bountyId)).toEqual(before);
    expect(await submissionRow(first.id)).toMatchObject({ status: 'REVISION_REQUESTED', current_revision_no: 1 });
  });

  it('submission mode: a person on an AGENT bounty is AGENT_SUBMISSION_REQUIRED, an agent on a DIRECT bounty is DIRECT_SUBMISSION_REQUIRED; the matching actor is accepted', async () => {
    const owner = await createUser(db);
    const agentId = await agentOf(owner);
    const agentOnly = await bountyIn({ mode: 'AGENT' });
    const directOnly = await bountyIn({ mode: 'DIRECT' });

    await expect(submissions.submit(agentOnly, owner, work(1))).rejects.toMatchObject({ status: 400, message: 'AGENT_SUBMISSION_REQUIRED' });
    await expect(submissions.submitAsAgent(directOnly, agentId, work(1))).rejects.toMatchObject({ status: 400, message: 'DIRECT_SUBMISSION_REQUIRED' });
    expect(await countRows(agentOnly)).toEqual({ submissions: 0, revisions: 0 });
    expect(await countRows(directOnly)).toEqual({ submissions: 0, revisions: 0 });

    await expect(submissions.submit(directOnly, owner, work(1))).resolves.toMatchObject({ revisionNo: 1, status: 'SUBMITTED' });
    await expect(submissions.submitAsAgent(agentOnly, agentId, work(2))).resolves.toMatchObject({ revisionNo: 1, status: 'SUBMITTED' });
  });

  it('an agent submission stores agent_id (no submitter) on the row and the first revision snapshot, with every optional field', async () => {
    const owner = await createUser(db);
    const agentId = await agentOf(owner);
    const bountyId = await bountyIn({ mode: 'AGENT' });
    const input = { submissionUrl: 'https://x.test/a', description: 'by agent', repositoryUrl: 'https://github.com/x/y', commitSha: 'abc' };
    const out = await submissions.submitAsAgent(bountyId, agentId, input);
    expect(out).toEqual({ id: expect.any(String), revisionNo: 1, status: 'SUBMITTED' });

    const row = await db.query(`SELECT submitter_user_id, agent_id, application_id, submission_url, description, repository_url, commit_sha FROM bounty_submission WHERE id = $1`, [out.id]);
    expect(row.rows[0]).toEqual({ submitter_user_id: null, agent_id: agentId, application_id: null, submission_url: input.submissionUrl, description: input.description, repository_url: input.repositoryUrl, commit_sha: 'abc' });
    const revision = await db.query(`SELECT revision_no, submission_url, description, repository_url, commit_sha, created_by_user_id, created_by_agent_id FROM submission_revision WHERE submission_id = $1`, [out.id]);
    expect(revision.rows).toEqual([{ revision_no: 1, submission_url: input.submissionUrl, description: input.description, repository_url: input.repositoryUrl, commit_sha: 'abc', created_by_user_id: null, created_by_agent_id: agentId }]);
  });

  it('an application bounty needs an APPROVED application of this very actor (none, pending, rejected, someone else\'s do not count) and links it to the submission', async () => {
    const bountyId = await bountyIn({ applicationRequired: true, mode: 'DIRECT' });
    const user = await createUser(db);
    const other = await createUser(db);

    await expect(submissions.submit(bountyId, user, work(1))).rejects.toMatchObject({ status: 403, message: 'APPLICATION_NOT_APPROVED' });
    const pending = await applications.apply(bountyId, user, 'hi');
    await expect(submissions.submit(bountyId, user, work(1))).rejects.toMatchObject({ message: 'APPLICATION_NOT_APPROVED' });
    await applicationReview.review(pending.id, 'REJECTED', 'no', adminId);
    await expect(submissions.submit(bountyId, user, work(1))).rejects.toMatchObject({ message: 'APPLICATION_NOT_APPROVED' });
    const othersApp = await applications.apply(bountyId, other, 'hi');
    await applicationReview.review(othersApp.id, 'APPROVED', undefined, adminId);
    await expect(submissions.submit(bountyId, user, work(1))).rejects.toMatchObject({ message: 'APPLICATION_NOT_APPROVED' });
    expect(await countRows(bountyId)).toEqual({ submissions: 0, revisions: 0 });

    // approved: the submission row points at that application (people by applicant_user_id)
    const mine = await submissions.submit(bountyId, other, work(2));
    expect((await db.query(`SELECT application_id FROM bounty_submission WHERE id = $1`, [mine.id])).rows[0].application_id).toBe(othersApp.id);
  });

  it('an agent on an application bounty is looked up by agent_id: another agent\'s approval does not count, its own links the submission', async () => {
    const bountyId = await bountyIn({ applicationRequired: true, mode: 'AGENT' });
    const owner = await createUser(db);
    const agentId = await agentOf(owner);
    const otherAgent = await agentOf(await createUser(db));

    await expect(submissions.submitAsAgent(bountyId, agentId, work(1))).rejects.toMatchObject({ status: 403, message: 'APPLICATION_NOT_APPROVED' });
    const othersApp = await applications.applyAsAgent(bountyId, otherAgent, 'hi');
    await applicationReview.review(othersApp.id, 'APPROVED', undefined, adminId);
    await expect(submissions.submitAsAgent(bountyId, agentId, work(1))).rejects.toMatchObject({ message: 'APPLICATION_NOT_APPROVED' });
    expect(await countRows(bountyId)).toEqual({ submissions: 0, revisions: 0 });

    const own = await applications.applyAsAgent(bountyId, agentId, 'hi');
    await applicationReview.review(own.id, 'APPROVED', undefined, adminId);
    const viaAgent = await submissions.submitAsAgent(bountyId, agentId, work(3));
    expect((await db.query(`SELECT application_id FROM bounty_submission WHERE id = $1`, [viaAgent.id])).rows[0].application_id).toBe(own.id);
  });

  it.each([
    ['SUBMISSION_CLOSED', 'before the deadline'],
    ['IN_REVIEW', 'before the deadline'],
  ])('a first submission once intake closed (%s, %s) is 400 BOUNTY_NOT_OPEN; past the deadline on an OPEN bounty it is 400 DEADLINE_PASSED', async (status) => {
    const user = await createUser(db);
    const closed = await bountyIn({ status });
    await expect(submissions.submit(closed, user, work(1))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    const late = await bountyIn({ status: 'OPEN', deadline: PAST() });
    await expect(submissions.submit(late, user, work(1))).rejects.toMatchObject({ status: 400, message: 'DEADLINE_PASSED' });
    expect(await countRows(closed)).toEqual({ submissions: 0, revisions: 0 });
    expect(await countRows(late)).toEqual({ submissions: 0, revisions: 0 });
  });

  // [bounty status, deadline, existing submission status] -> outcome of a resubmission (a revision is delivered, or the error message)
  const OK = 'RESUBMITTED';
  const matrix: Array<[string, 'future' | 'past', string, string]> = [
    // open and before the deadline: free edits until reviewed to a final decision
    ['OPEN', 'future', 'SUBMITTED', OK],
    ['OPEN', 'future', 'RESUBMITTED', OK],
    ['OPEN', 'future', 'IN_REVIEW', OK],
    ['OPEN', 'future', 'REVISION_REQUESTED', OK],
    ['OPEN', 'future', 'APPROVED', 'SUBMISSION_FINALIZED'],
    ['OPEN', 'future', 'REJECTED', 'SUBMISSION_FINALIZED'],
    // open but past the deadline: only a requested revision may still be delivered
    ['OPEN', 'past', 'REVISION_REQUESTED', OK],
    ['OPEN', 'past', 'SUBMITTED', 'DEADLINE_PASSED'],
    ['OPEN', 'past', 'RESUBMITTED', 'DEADLINE_PASSED'],
    ['OPEN', 'past', 'IN_REVIEW', 'DEADLINE_PASSED'],
    ['OPEN', 'past', 'APPROVED', 'DEADLINE_PASSED'],
    // intake closed / review: same, by status instead of by clock
    ['SUBMISSION_CLOSED', 'past', 'REVISION_REQUESTED', OK],
    ['IN_REVIEW', 'past', 'REVISION_REQUESTED', OK],
    ['IN_REVIEW', 'future', 'REVISION_REQUESTED', OK],
    ['SUBMISSION_CLOSED', 'past', 'SUBMITTED', 'BOUNTY_NOT_OPEN'],
    ['IN_REVIEW', 'past', 'SUBMITTED', 'BOUNTY_NOT_OPEN'],
    ['IN_REVIEW', 'past', 'RESUBMITTED', 'BOUNTY_NOT_OPEN'],
    ['IN_REVIEW', 'past', 'IN_REVIEW', 'BOUNTY_NOT_OPEN'],
    ['IN_REVIEW', 'past', 'APPROVED', 'BOUNTY_NOT_OPEN'],
    ['SUBMISSION_CLOSED', 'future', 'REJECTED', 'BOUNTY_NOT_OPEN'],
    // finished bounties take nothing, not even a requested revision
    ['COMPLETED', 'past', 'REVISION_REQUESTED', 'BOUNTY_NOT_OPEN'],
  ];
  it.each(matrix)('resubmission on a %s bounty (deadline %s) of a %s submission -> %s', async (bountyStatus, clock, existingStatus, outcome) => {
    const user = await createUser(db);
    const bountyId = await bountyIn();
    const first = await submissions.submit(bountyId, user, { submissionUrl: 'https://x.test/old', description: 'old', repositoryUrl: 'https://github.com/x/y', commitSha: 'abc' });
    await db.query(`UPDATE bounty_submission SET status = $2, current_revision_no = 2 WHERE id = $1`, [first.id, existingStatus]);
    await db.query(`UPDATE submission_revision SET revision_no = 2 WHERE submission_id = $1`, [first.id]);
    await db.query(`UPDATE bounty SET status = $2, submission_deadline = $3 WHERE id = $1`, [bountyId, bountyStatus, clock === 'past' ? PAST() : FUTURE()]);
    const before = await countRows(bountyId);
    const next = { submissionUrl: 'https://x.test/new', description: 'new' }; // optional fields omitted: a resubmission replaces everything

    if (outcome === OK) {
      await expect(submissions.submit(bountyId, user, next)).resolves.toEqual({ id: first.id, revisionNo: 3, status: 'RESUBMITTED' });
      expect(await submissionRow(first.id)).toMatchObject({ status: 'RESUBMITTED', current_revision_no: 3, submission_url: next.submissionUrl, description: next.description, repository_url: null, commit_sha: null });
      expect((await submissionRow(first.id)).last_resubmitted_at).toBeInstanceOf(Date);
      const revision = await db.query(`SELECT submission_url, description, repository_url, commit_sha, created_by_user_id, created_by_agent_id FROM submission_revision WHERE submission_id = $1 AND revision_no = 3`, [first.id]);
      expect(revision.rows).toEqual([{ submission_url: next.submissionUrl, description: next.description, repository_url: null, commit_sha: null, created_by_user_id: user, created_by_agent_id: null }]);
      expect((await countRows(bountyId)).revisions).toBe(before.revisions + 1);
    } else {
      const expectedStatus = outcome === 'SUBMISSION_FINALIZED' ? 409 : 400;
      await expect(submissions.submit(bountyId, user, next)).rejects.toMatchObject({ status: expectedStatus, message: outcome });
      expect(await countRows(bountyId)).toEqual(before);
      expect(await submissionRow(first.id)).toMatchObject({ status: existingStatus, current_revision_no: 2, submission_url: 'https://x.test/old', description: 'old', repository_url: 'https://github.com/x/y', commit_sha: 'abc' });
    }
  });

  it('revision numbers follow the row: each delivery adds exactly one snapshot, and an agent resubmission records the agent, not its owner', async () => {
    const owner = await createUser(db);
    const agentId = await agentOf(owner);
    const bountyId = await bountyIn({ mode: 'AGENT' });
    const first = await submissions.submitAsAgent(bountyId, agentId, work(1));
    await expect(submissions.submitAsAgent(bountyId, agentId, work(2))).resolves.toEqual({ id: first.id, revisionNo: 2, status: 'RESUBMITTED' });
    await expect(submissions.submitAsAgent(bountyId, agentId, work(3))).resolves.toEqual({ id: first.id, revisionNo: 3, status: 'RESUBMITTED' });
    const revisions = await db.query(`SELECT revision_no, created_by_user_id, created_by_agent_id FROM submission_revision WHERE submission_id = $1 ORDER BY revision_no`, [first.id]);
    expect(revisions.rows).toEqual([1, 2, 3].map((n) => ({ revision_no: n, created_by_user_id: null, created_by_agent_id: agentId })));
  });

  describe('mySubmissions', () => {
    async function fundedOpenBounty() {
      const { id } = await bounties.create(adminId, {
        title: unique('mine-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DESIGN', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 1, submissionDeadline: FUTURE(),
        reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1000' },
      });
      const reward = await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [id]);
      await rewards.confirmDeposit(reward.rows[0].id, fakeTxHash(), '1000', adminId);
      await bounties.transition(id, 'OPEN', adminId);
      return id;
    }

    it('lists my own and my live agents\' submissions (agent {id, name} or null), newest first, with bounty fields; hides deleted bounties, deleted agents and other people\'s rows', async () => {
      const me = await createUser(db);
      const stranger = await createUser(db);
      const agentId = await agentOf(me, 'my-bot');
      const strangerAgent = await agentOf(stranger);

      const first = await bountyIn();
      const second = await bountyIn();
      const deletedBounty = await bountyIn();
      const strangerSide = await bountyIn();
      const agentSide = await bountyIn({ mode: 'AGENT' });
      const retiredSide = await bountyIn({ mode: 'AGENT' });
      const strangerAgentSide = await bountyIn({ mode: 'AGENT' });
      const mineFirst = await submissions.submit(first, me, work('a'));
      const mineSecond = await submissions.submit(second, me, work('b'));
      await submissions.submit(deletedBounty, me, work('c'));
      const viaAgent = await submissions.submitAsAgent(agentSide, agentId, work('d'));
      await submissions.submitAsAgent(retiredSide, agentId, work('e'));
      await submissions.submitAsAgent(strangerAgentSide, strangerAgent, work('f'));
      await submissions.submit(strangerSide, stranger, work('g'));
      // fix the order explicitly and retire/delete what must disappear
      await db.query(`UPDATE bounty_submission SET submitted_at = now() - interval '3 days' WHERE id = $1`, [mineFirst.id]);
      await db.query(`UPDATE bounty_submission SET submitted_at = now() - interval '1 day' WHERE id = $1`, [mineSecond.id]);
      await db.query(`UPDATE bounty_submission SET submitted_at = now() - interval '2 days' WHERE id = $1`, [viaAgent.id]);
      await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [deletedBounty]);
      await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [retiredSide]);

      const rows = await submissions.mySubmissions(me);
      expect(rows.map((r) => r.id)).toEqual([mineSecond.id, viaAgent.id, mineFirst.id]);
      expect(rows[0]).toMatchObject({ bounty_id: second, category: 'DEV', bounty_status: 'OPEN', status: 'SUBMITTED', current_revision_no: 1, agent: null, description: 'revision b', submission_url: 'https://x.test/work/b' });
      expect(rows[0].submission_deadline).toBeInstanceOf(Date);
      expect(rows[1].agent).toEqual({ id: agentId, name: 'my-bot' });
    });

    it('does not list submissions of an agent that was soft-deleted (live ownership only)', async () => {
      const me = await createUser(db);
      const agentId = await agentOf(me);
      const bountyId = await bountyIn({ mode: 'AGENT' });
      const sub = await submissions.submitAsAgent(bountyId, agentId, work(1));
      expect((await submissions.mySubmissions(me)).map((r) => r.id)).toContain(sub.id);
      await db.query(`UPDATE agent SET deleted_at = now() WHERE id = $1`, [agentId]);
      expect((await submissions.mySubmissions(me)).map((r) => r.id)).not.toContain(sub.id);
    });

    it('payment_status is NONE for anything not APPROVED (even with a funded, unpaid reward), and the payout state only for approved submissions', async () => {
      const me = await createUser(db);
      await createPrimaryWallet(db, me);
      const bountyId = await fundedOpenBounty();
      const sub = await submissions.submit(bountyId, me, work(1));
      const status = async () => (await submissions.mySubmissions(me)).find((r) => r.id === sub.id)!.payment_status;
      for (const state of ['SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'REJECTED']) {
        await db.query(`UPDATE bounty_submission SET status = $2 WHERE id = $1`, [sub.id, state]);
        expect(await status()).toBe('NONE');
      }
      await db.query(`UPDATE bounty_submission SET status = 'SUBMITTED' WHERE id = $1`, [sub.id]);
      await submissionReview.review(sub.id, 'APPROVE', undefined, adminId);
      expect(await status()).toBe('PENDING'); // approved, reward funded, nothing requested yet
    });

    it('has_review: true for a decided review, false without one, and false for the comment-less REJECT a cancellation leaves behind (a comment keeps it true)', async () => {
      const me = await createUser(db);
      const bountyId = await bountyIn();
      const sub = await submissions.submit(bountyId, me, work(1));
      const find = async () => (await submissions.mySubmissions(me)).find((r) => r.id === sub.id)!;
      expect(await find()).toMatchObject({ has_review: false, review_comment: null });

      const addReview = (decision: string, comment: string | null, ageSeconds: number) => db.query(
        `INSERT INTO submission_review (submission_id, reviewer_id, decision, comment, created_at) VALUES ($1, $2, $3, $4, now() - $5 * interval '1 second')`,
        [sub.id, adminId, decision, comment, ageSeconds]);
      await addReview('REJECT', null, 20);
      expect(await find()).toMatchObject({ has_review: true, review_comment: null }); // bounty not cancelled: an operator rejection
      await db.query(`UPDATE bounty SET status = 'CANCELLED' WHERE id = $1`, [bountyId]);
      expect(await find()).toMatchObject({ has_review: false, bounty_status: 'CANCELLED' }); // system clean-up of a cancelled bounty
      await addReview('REJECT', 'explained', 10);
      expect(await find()).toMatchObject({ has_review: true, review_comment: 'explained' }); // the newest review wins
    });
  });
});
