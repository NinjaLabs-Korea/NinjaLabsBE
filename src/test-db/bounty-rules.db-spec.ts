import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser, deferred, fakeTxHash, testConfig, unique, waitForLockWaiter } from './harness';

/**
 * Bounty status walk, lifecycle blockers from real rows, the revision flow across the deadline, and the races the row locks /
 * advisory locks exist for — on a real Postgres with the real services (bounty-flow.db-spec.ts covers the happy money path).
 */
describeDb('bounty rules on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let nfts: NftsService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;
  let approverId: string;

  beforeAll(async () => {
    db = createDb();
    audit = new AuditService(db);
    const config = testConfig();
    nfts = new NftsService(db, config);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config), config);
    rewards = new RewardsService(db, nfts, audit, config);
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onModuleDestroy());

  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const work = (n: number | string) => ({ submissionUrl: `https://x.test/work/${n}`, description: `revision ${n}` });

  async function createBounty(options: { applicationRequired?: boolean; maxWinners?: number; amount?: string } = {}) {
    const { id } = await bounties.create(adminId, {
      title: unique('rules-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: options.applicationRequired ?? false, submissionMode: 'DIRECT', maxWinners: options.maxWinners ?? 1,
      submissionDeadline: inDays(7),
      reward: options.amount ? { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: options.amount } : undefined,
    });
    return id;
  }
  async function rewardOf(bountyId: string) {
    return (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
  }
  async function openFunded(options: { applicationRequired?: boolean; maxWinners?: number; amount?: string } = {}) {
    const bountyId = await createBounty({ amount: '1000', ...options });
    const rewardId = await rewardOf(bountyId);
    await rewards.confirmDeposit(rewardId, fakeTxHash(), options.amount ?? '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);
    return { bountyId, rewardId };
  }
  async function row(bountyId: string) {
    const r = await db.query<{ status: string; opened_at: Date | null; review_started_at: Date | null; completed_at: Date | null; deleted_at: Date | null }>(
      `SELECT status, opened_at, review_started_at, completed_at, deleted_at FROM bounty WHERE id = $1`, [bountyId]);
    return r.rows[0];
  }
  async function expireDeadline(bountyId: string) {
    await db.query(`UPDATE bounty SET submission_deadline = now() - interval '1 minute' WHERE id = $1`, [bountyId]);
  }
  async function approvedSubmission(bountyId: string) {
    const userId = await createUser(db);
    await createPrimaryWallet(db, userId);
    const sub = await submissions.submit(bountyId, userId, work(unique()));
    await submissionReview.review(sub.id, 'APPROVE', undefined, adminId);
    return sub.id;
  }
  const blockersOf = (err: unknown) => ((err as BadRequestException).getResponse() as { message: string[] }).message;

  describe('status walk', () => {
    it('DRAFT → FUNDING_PENDING → OPEN ⇄ SUBMISSION_CLOSED → IN_REVIEW ⇄ OPEN … → COMPLETED stamps each first entry once, then nothing leaves COMPLETED', async () => {
      const id = await createBounty();
      expect((await row(id)).status).toBe('DRAFT'); // no reward → no FUNDING_PENDING on create
      await expect(bounties.transition(id, 'FUNDING_PENDING', adminId)).resolves.toEqual({ id, status: 'FUNDING_PENDING' });
      await bounties.transition(id, 'OPEN', adminId);
      const firstOpened = (await row(id)).opened_at!;
      expect(firstOpened).toBeInstanceOf(Date);

      await bounties.transition(id, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(id, 'OPEN', adminId); // reopen
      expect((await row(id)).opened_at!.getTime()).toBe(firstOpened.getTime());
      await bounties.transition(id, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(id, 'IN_REVIEW', adminId);
      const firstReview = (await row(id)).review_started_at!;
      expect(firstReview).toBeInstanceOf(Date);
      await bounties.transition(id, 'OPEN', adminId); // reopen from review
      await bounties.transition(id, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(id, 'IN_REVIEW', adminId);
      expect((await row(id)).review_started_at!.getTime()).toBe(firstReview.getTime());
      expect((await row(id)).completed_at).toBeNull();
      await bounties.transition(id, 'COMPLETED', adminId);
      expect((await row(id))).toMatchObject({ status: 'COMPLETED', completed_at: expect.any(Date) });

      for (const to of ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']) {
        await expect(bounties.transition(id, to, adminId)).rejects.toMatchObject({ status: 400, message: `INVALID_TRANSITION:COMPLETED->${to}` });
      }
      expect(await auditActions(db, 'bounty', id)).toEqual([
        'BOUNTY_CREATED', 'BOUNTY_FUNDING_PENDING', 'BOUNTY_OPEN', 'BOUNTY_SUBMISSION_CLOSED', 'BOUNTY_OPEN', 'BOUNTY_SUBMISSION_CLOSED',
        'BOUNTY_IN_REVIEW', 'BOUNTY_OPEN', 'BOUNTY_SUBMISSION_CLOSED', 'BOUNTY_IN_REVIEW', 'BOUNTY_COMPLETED',
      ]);
    });

    it('DRAFT, FUNDING_PENDING and OPEN can be cancelled; a cancelled bounty is final and closes participation', async () => {
      const draft = await createBounty();
      await expect(bounties.transition(draft, 'CANCELLED', adminId)).resolves.toEqual({ id: draft, status: 'CANCELLED' });
      const pending = await createBounty({ amount: '10' });
      expect((await row(pending)).status).toBe('FUNDING_PENDING');
      await expect(bounties.transition(pending, 'CANCELLED', adminId)).resolves.toEqual({ id: pending, status: 'CANCELLED' });

      const { bountyId: open } = await openFunded({ applicationRequired: true });
      const builder = await createUser(db);
      const application = await applications.apply(open, builder, 'hi');
      await expect(bounties.transition(open, 'CANCELLED', adminId)).resolves.toEqual({ id: open, status: 'CANCELLED' });
      await expect(bounties.transition(open, 'OPEN', adminId)).rejects.toMatchObject({ message: 'INVALID_TRANSITION:CANCELLED->OPEN' });
      await expect(applications.apply(open, await createUser(db), 'late')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
      await expect(applicationReview.review(application.id, 'APPROVED', undefined, adminId)).rejects.toMatchObject({ message: 'BOUNTY_REVIEW_CLOSED' });
      await expect(submissions.submit(open, builder, work(1))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    });

    it('a soft-deleted bounty cannot be transitioned (404 BOUNTY_NOT_FOUND)', async () => {
      const id = await createBounty();
      await bounties.remove(id, adminId);
      await expect(bounties.transition(id, 'OPEN', adminId)).rejects.toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
    });
  });

  describe('lifecycle blockers computed from real rows', () => {
    it('closing waits for pending applications, then for approved participants until the deadline passes', async () => {
      const id = await createBounty({ applicationRequired: true });
      await bounties.transition(id, 'OPEN', adminId);
      const builder = await createUser(db);
      const application = await applications.apply(id, builder, 'hi');
      // another bounty's pending application must not count here
      const other = await createBounty({ applicationRequired: true });
      await bounties.transition(other, 'OPEN', adminId);
      await applications.apply(other, await createUser(db), 'elsewhere');

      expect(blockersOf(await bounties.transition(id, 'SUBMISSION_CLOSED', adminId).catch((e: unknown) => e)))
        .toEqual(['Review 1 pending application(s) before closing submissions.']);
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
      expect(blockersOf(await bounties.transition(id, 'SUBMISSION_CLOSED', adminId).catch((e: unknown) => e)))
        .toEqual(['1 approved participant(s) have not submitted. Wait for their work or the submission deadline.']);

      // the participant submits → no longer blocking
      await submissions.submit(id, builder, work(1));
      await expect(bounties.transition(id, 'SUBMISSION_CLOSED', adminId)).resolves.toMatchObject({ status: 'SUBMISSION_CLOSED' });

      // a second bounty: the approved participant never submits, the deadline passes → closing is allowed
      const silent = await createBounty({ applicationRequired: true });
      await bounties.transition(silent, 'OPEN', adminId);
      const ghost = await applications.apply(silent, await createUser(db), 'hi');
      await applicationReview.review(ghost.id, 'APPROVED', undefined, adminId);
      await expect(bounties.transition(silent, 'SUBMISSION_CLOSED', adminId)).rejects.toBeInstanceOf(BadRequestException);
      await expireDeadline(silent);
      await expect(bounties.transition(silent, 'SUBMISSION_CLOSED', adminId)).resolves.toMatchObject({ status: 'SUBMISSION_CLOSED' });
      // …and it cannot be reopened while the deadline is in the past
      expect(blockersOf(await bounties.transition(silent, 'OPEN', adminId).catch((e: unknown) => e)))
        .toEqual(['Extend the submission deadline before opening this bounty.']);
    });

    it('completion waits for every submission review (a requested revision counts) and for winners to be paid', async () => {
      const { bountyId, rewardId } = await openFunded({ maxWinners: 2 });
      const userA = await createUser(db);
      await createPrimaryWallet(db, userA);
      const subA = await submissions.submit(bountyId, userA, work('a'));
      const subB = await submissions.submit(bountyId, await createUser(db), work('b'));
      await expireDeadline(bountyId);
      await bounties.transition(bountyId, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(bountyId, 'IN_REVIEW', adminId);

      expect(blockersOf(await bounties.transition(bountyId, 'COMPLETED', adminId).catch((e: unknown) => e)))
        .toEqual(['Finish 2 submission review(s), including requested revisions.']);
      await submissionReview.review(subB.id, 'REQUEST_REVISION', 'missing tests', adminId);
      await submissionReview.review(subA.id, 'APPROVE', undefined, adminId);
      expect(blockersOf(await bounties.transition(bountyId, 'COMPLETED', adminId).catch((e: unknown) => e))).toEqual([
        'Finish 1 submission review(s), including requested revisions.',
        'Record completed payments for all approved winners and finish every pending payout.',
      ]);
      await submissionReview.review(subB.id, 'REJECT', 'revision never delivered', adminId);
      // approved but unpaid winner (unawarded), then an open payout (unpaid)
      expect(blockersOf(await bounties.transition(bountyId, 'COMPLETED', adminId).catch((e: unknown) => e)))
        .toEqual(['Record completed payments for all approved winners and finish every pending payout.']);
      const payout = await rewards.requestPayout(rewardId, subA.id, '1000', adminId);
      await rewards.markApproved(payout.id, approverId);
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toBeInstanceOf(BadRequestException);
      await rewards.markPaid(payout.id, fakeTxHash(), adminId);
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
    });

    it('a reward-less bounty with an approved winner can complete (nothing to pay)', async () => {
      const id = await createBounty();
      await bounties.transition(id, 'OPEN', adminId);
      await approvedSubmission(id);
      await bounties.transition(id, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(id, 'IN_REVIEW', adminId);
      await expect(bounties.transition(id, 'COMPLETED', adminId)).resolves.toEqual({ id, status: 'COMPLETED' });
    });
  });

  it('revision flow across the deadline: snapshots per revision, reviews pinned to the revision they judged, only REVISION_REQUESTED may resubmit late', async () => {
    const id = await createBounty({ maxWinners: 2 });
    await bounties.transition(id, 'OPEN', adminId);
    const userA = await createUser(db);
    const userB = await createUser(db);

    const a1 = await submissions.submit(id, userA, work(1));
    expect(a1).toEqual({ id: expect.any(String), revisionNo: 1, status: 'SUBMITTED' });
    await expect(submissionReview.review(a1.id, 'START_REVIEW', undefined, adminId, 1)).resolves.toEqual({ id: a1.id, status: 'IN_REVIEW' });
    await expect(submissions.submit(id, userA, work(2))).resolves.toEqual({ id: a1.id, revisionNo: 2, status: 'RESUBMITTED' }); // edit during review resets it
    await expect(submissionReview.review(a1.id, 'REQUEST_REVISION', '  ', adminId, 2)).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    await expect(submissionReview.review(a1.id, 'REQUEST_REVISION', 'add tests', adminId, 2)).resolves.toEqual({ id: a1.id, status: 'REVISION_REQUESTED' });
    const b1 = await submissions.submit(id, userB, work('b1'));

    await expireDeadline(id);
    await bounties.transition(id, 'SUBMISSION_CLOSED', adminId);
    await expect(submissions.submit(id, userB, work('b2'))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' }); // SUBMITTED cannot edit any more
    await expect(submissions.submit(id, await createUser(db), work('new'))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    await expect(submissions.submit(id, userA, work(3))).resolves.toEqual({ id: a1.id, revisionNo: 3, status: 'RESUBMITTED' });
    await expect(submissions.submit(id, userA, work(4))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' }); // one delivery per request

    await expect(submissionReview.review(a1.id, 'APPROVE', 'ship it', adminId, 2)).rejects.toMatchObject({ message: 'SUBMISSION_REVISION_CHANGED' });
    await expect(submissionReview.review(a1.id, 'APPROVE', 'ship it', adminId, 3)).resolves.toEqual({ id: a1.id, status: 'APPROVED' });
    await expect(submissionReview.review(a1.id, 'REJECT', 'changed my mind', adminId)).rejects.toMatchObject({ message: 'SUBMISSION_NOT_REVIEWABLE' });

    const revisions = await db.query(`SELECT revision_no, submission_url, created_by_user_id FROM submission_revision WHERE submission_id = $1 ORDER BY revision_no`, [a1.id]);
    expect(revisions.rows).toEqual([1, 2, 3].map((n) => ({ revision_no: n, submission_url: `https://x.test/work/${n}`, created_by_user_id: userA })));
    const reviews = await db.query(`SELECT v.decision, r.revision_no, v.comment, v.reviewer_id FROM submission_review v JOIN submission_revision r ON r.id = v.revision_id
      WHERE v.submission_id = $1 ORDER BY v.created_at`, [a1.id]);
    expect(reviews.rows).toEqual([
      { decision: 'START_REVIEW', revision_no: 1, comment: null, reviewer_id: adminId },
      { decision: 'REQUEST_REVISION', revision_no: 2, comment: 'add tests', reviewer_id: adminId },
      { decision: 'APPROVE', revision_no: 3, comment: 'ship it', reviewer_id: adminId },
    ]);
    expect(await auditActions(db, 'bounty_submission', a1.id)).toEqual(expect.arrayContaining(['SUBMISSION_START_REVIEW', 'SUBMISSION_REQUEST_REVISION', 'SUBMISSION_APPROVE']));
    const mine = await submissions.mySubmissions(userA);
    expect(mine).toEqual([expect.objectContaining({ id: a1.id, status: 'APPROVED', current_revision_no: 3, review_comment: 'ship it', payment_status: 'NONE' })]);

    // B: a revision is requested after intake closed and never delivered → reject needs a comment, then completion is free
    await submissionReview.review(b1.id, 'REQUEST_REVISION', 'please fix', adminId);
    await bounties.transition(id, 'IN_REVIEW', adminId);
    await expect(bounties.transition(id, 'COMPLETED', adminId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(submissionReview.review(b1.id, 'REJECT', undefined, adminId)).rejects.toMatchObject({ message: 'REVISION_COMMENT_REQUIRED' });
    await expect(submissionReview.review(b1.id, 'REJECT', 'not delivered', adminId)).resolves.toEqual({ id: b1.id, status: 'REJECTED' });
    await expect(bounties.transition(id, 'COMPLETED', adminId)).resolves.toEqual({ id, status: 'COMPLETED' });
    await expect(submissions.submit(id, userB, work('b3'))).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
  });

  it('withdrawal is limited to the applicant and their own agents, and only while PENDING', async () => {
    const id = await createBounty({ applicationRequired: true });
    await bounties.transition(id, 'OPEN', adminId);
    const owner = await createUser(db);
    const stranger = await createUser(db);
    const application = await applications.apply(id, owner, 'hi');
    await expect(applications.withdraw(application.id, stranger)).rejects.toMatchObject({ status: 404, message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    await expect(applications.withdraw(application.id, owner)).rejects.toMatchObject({ message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [application.id])).rows[0].status).toBe('APPROVED');
  });

  describe('races (Promise.allSettled = two real concurrent transactions on separate pool clients)', () => {
    const split = <T,>(results: PromiseSettledResult<T>[]) => ({
      fulfilled: results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map((r) => r.value),
      rejected: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error),
    });

    /** An AuditService that parks the transaction recording `action` on `entityId` until released (everything before it is done but uncommitted) */
    function parkingAudit(action: string, entityId: string) {
      const parked = deferred<void>();
      const release = deferred<void>();
      const service = {
        record: async (actor: string | undefined, act: string, type: string, id: string, runner?: unknown) => {
          if (act === action && id === entityId) { parked.resolve(); await release.promise; }
          return audit.record(actor, act, type, id, runner as never);
        },
      } as unknown as AuditService;
      return { service, parked: parked.promise, release: () => release.resolve() };
    }

    it('a second APPROVE while the first is uncommitted at max_winners 1: it waits on the bounty row, then 400 MAX_WINNERS_REACHED', async () => {
      const id = await createBounty({ maxWinners: 1 });
      await bounties.transition(id, 'OPEN', adminId);
      const subs = [await submissions.submit(id, await createUser(db), work(1)), await submissions.submit(id, await createUser(db), work(2))];
      // T1 approves and parks before committing; without the bounty row lock T2 would count 0 approved (T1 invisible) and approve too
      const parking = parkingAudit('SUBMISSION_APPROVE', subs[0].id);
      const t1 = new SubmissionReviewService(db, parking.service).review(subs[0].id, 'APPROVE', undefined, adminId);
      await parking.parked;
      const t2 = submissionReview.review(subs[1].id, 'APPROVE', undefined, adminId).then((r) => r, (err: Error) => err);
      await Promise.race([waitForLockWaiter(db, 'the second approval to wait on the bounty row'), t2]);
      parking.release();
      await expect(t1).resolves.toEqual({ id: subs[0].id, status: 'APPROVED' });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(BadRequestException);
      expect((outcome as Error).message).toBe('MAX_WINNERS_REACHED');
      const approved = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`, [id]);
      expect(approved.rows[0].n).toBe(1);
    });

    it('lowering maxWinners while an APPROVE is in flight never leaves more winners than max_winners', async () => {
      const id = await createBounty({ maxWinners: 2 });
      await bounties.transition(id, 'OPEN', adminId);
      await approvedSubmission(id);
      const pending = await submissions.submit(id, await createUser(db), work('p'));
      const results = await Promise.allSettled([
        bounties.update(id, { maxWinners: 1 }, adminId),
        submissionReview.review(pending.id, 'APPROVE', undefined, adminId),
      ]);
      const { fulfilled, rejected } = split(results);
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(['MAX_WINNERS_BELOW_APPROVED', 'MAX_WINNERS_REACHED']).toContain(rejected[0].message);
      const state = await db.query<{ max_winners: number; approved: number }>(
        `SELECT b.max_winners, (SELECT count(*)::int FROM bounty_submission s WHERE s.bounty_id = b.id AND s.status = 'APPROVED') AS approved FROM bounty b WHERE b.id = $1`, [id]);
      expect(state.rows[0].approved).toBeLessThanOrEqual(state.rows[0].max_winners);
    });

    it('the same user applying twice at once: one application row, the other 409 ALREADY_APPLIED', async () => {
      const id = await createBounty({ applicationRequired: true });
      await bounties.transition(id, 'OPEN', adminId);
      const builder = await createUser(db);
      const { fulfilled, rejected } = split(await Promise.allSettled([applications.apply(id, builder, 'one'), applications.apply(id, builder, 'two')]));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(ConflictException);
      expect(rejected[0].message).toBe('ALREADY_APPLIED');
      const rows = await db.query(`SELECT id, status FROM bounty_application WHERE bounty_id = $1 AND applicant_user_id = $2`, [id, builder]);
      expect(rows.rows).toEqual([{ id: (fulfilled[0] as { id: string }).id, status: 'PENDING' }]);
    });

    it('two re-applications after a withdrawal at once: the row is reopened once (one APPLICATION_REAPPLIED), the other 409', async () => {
      const id = await createBounty({ applicationRequired: true });
      await bounties.transition(id, 'OPEN', adminId);
      const builder = await createUser(db);
      const first = await applications.apply(id, builder, 'first');
      await applications.withdraw(first.id, builder);
      const { fulfilled, rejected } = split(await Promise.allSettled([applications.apply(id, builder, 'again A'), applications.apply(id, builder, 'again B')]));
      expect(fulfilled).toEqual([expect.objectContaining({ id: first.id, status: 'PENDING' })]);
      expect(rejected.map((e) => e.message)).toEqual(['ALREADY_APPLIED']);
      expect(await auditActions(db, 'bounty_application', first.id)).toEqual(['APPLICATION_REAPPLIED']);
      const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty_application WHERE bounty_id = $1`, [id]);
      expect(count.rows[0].n).toBe(1);
    });

    it('withdraw racing an approval: exactly one of them lands, the loser gets 404 APPLICATION_NOT_FOUND_OR_NOT_PENDING', async () => {
      const id = await createBounty({ applicationRequired: true });
      await bounties.transition(id, 'OPEN', adminId);
      const builder = await createUser(db);
      const application = await applications.apply(id, builder, 'hi');
      const results = await Promise.allSettled([
        applications.withdraw(application.id, builder),
        applicationReview.review(application.id, 'APPROVED', undefined, adminId),
      ]);
      const { fulfilled, rejected } = split(results);
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(NotFoundException);
      expect(rejected[0].message).toBe('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
      const status = (await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [application.id])).rows[0].status;
      expect(status).toBe((fulfilled[0] as { status: string }).status);
      expect(await auditActions(db, 'bounty_application', application.id)).toEqual(status === 'APPROVED' ? ['APPLICATION_APPROVED'] : []);
    });

    it('the same user submitting twice at once: one submission row with revisions 1 and 2 (serialized on the bounty row)', async () => {
      const id = await createBounty();
      await bounties.transition(id, 'OPEN', adminId);
      const builder = await createUser(db);
      const results = await Promise.all([submissions.submit(id, builder, work('x')), submissions.submit(id, builder, work('y'))]);
      expect(results.map((r) => r.revisionNo).sort()).toEqual([1, 2]);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      const rows = await db.query<{ current_revision_no: number; status: string }>(`SELECT current_revision_no, status FROM bounty_submission WHERE bounty_id = $1`, [id]);
      expect(rows.rows).toEqual([{ current_revision_no: 2, status: 'RESUBMITTED' }]);
      const revs = await db.query<{ revision_no: number }>(`SELECT revision_no FROM submission_revision WHERE submission_id = $1 ORDER BY revision_no`, [results[0].id]);
      expect(revs.rows.map((r) => r.revision_no)).toEqual([1, 2]);
    });

    it('one deposit hash confirmed on two rewards at once: one FUNDED, the other 409 TX_HASH_ALREADY_USED and still DEPOSIT_PENDING', async () => {
      const rewardIds = [await rewardOf(await createBounty({ amount: '10' })), await rewardOf(await createBounty({ amount: '10' }))];
      const hash = fakeTxHash();
      const { fulfilled, rejected } = split(await Promise.allSettled([
        rewards.confirmDeposit(rewardIds[0], hash, '10', adminId),
        rewards.confirmDeposit(rewardIds[1], hash.toLowerCase(), '10', adminId),
      ]));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(ConflictException);
      expect(rejected[0].message).toBe('TX_HASH_ALREADY_USED');
      const statuses = await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = ANY($1::uuid[]) ORDER BY status`, [rewardIds]);
      expect(statuses.rows.map((r) => r.status)).toEqual(['DEPOSIT_PENDING', 'FUNDED']);
    });

    it('one reward confirmed twice at once with different hashes: one FUNDED with its hash, the other 404, one audit row', async () => {
      const rewardId = await rewardOf(await createBounty({ amount: '10' }));
      const hashes = [fakeTxHash(), fakeTxHash()];
      const { fulfilled, rejected } = split(await Promise.allSettled(hashes.map((h) => rewards.confirmDeposit(rewardId, h, '10', adminId))));
      expect(fulfilled).toHaveLength(1);
      expect(rejected.map((e) => e.message)).toEqual(['REWARD_NOT_FOUND_OR_NOT_PENDING']);
      const stored = (await db.query<{ deposit_tx_hash: string }>(`SELECT deposit_tx_hash FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].deposit_tx_hash;
      expect(hashes.map((h) => h.toLowerCase())).toContain(stored);
      expect(await auditActions(db, 'bounty_reward', rewardId)).toEqual(['REWARD_DEPOSIT_CONFIRMED']);
    });

    it('DELETE while a deposit confirmation is uncommitted: the delete waits on the bounty row and then refuses 409 BOUNTY_HAS_OPEN_FUNDS', async () => {
      const bountyId = await createBounty({ amount: '10' });
      const rewardId = await rewardOf(bountyId);
      const parking = parkingAudit('REWARD_DEPOSIT_CONFIRMED', rewardId);
      const parkedRewards = new RewardsService(db, nfts, parking.service, testConfig());
      const t1 = parkedRewards.confirmDeposit(rewardId, fakeTxHash(), '10', adminId);
      await parking.parked;
      const t2 = bounties.remove(bountyId, adminId).then(() => 'deleted' as const, (err: Error) => err);
      await Promise.race([waitForLockWaiter(db, 'the delete to wait on the bounty row'), t2]);
      parking.release();
      await expect(t1).resolves.toMatchObject({ status: 'FUNDED' });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((outcome as Error).message).toBe('BOUNTY_HAS_OPEN_FUNDS');
      expect((await row(bountyId)).deleted_at).toBeNull();
    });

    it('a deposit confirmation while a DELETE is uncommitted: it waits on the bounty row and then refuses 404 (no deposit on a deleted bounty)', async () => {
      const bountyId = await createBounty({ amount: '10' });
      const rewardId = await rewardOf(bountyId);
      const parking = parkingAudit('BOUNTY_DELETED', bountyId);
      const parkedBounties = new BountyAdminService(db, parking.service, new BountyLifecycleService(), new RewardTokenResolver(testConfig()), testConfig());
      const t1 = parkedBounties.remove(bountyId, adminId);
      await parking.parked;
      const t2 = rewards.confirmDeposit(rewardId, fakeTxHash(), '10', adminId).then(() => 'funded' as const, (err: Error) => err);
      await Promise.race([waitForLockWaiter(db, 'the deposit confirmation to wait on the bounty row'), t2]);
      parking.release();
      await expect(t1).resolves.toEqual({ id: bountyId });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(NotFoundException);
      expect((outcome as Error).message).toBe('REWARD_NOT_FOUND_OR_NOT_PENDING');
      expect((await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].status).toBe('DEPOSIT_PENDING');
    });

    it('a second payout request while the first is uncommitted, together over the cap: it waits, then 400 PAYOUT_EXCEEDS_AVAILABLE_REWARD', async () => {
      const { bountyId, rewardId } = await openFunded({ maxWinners: 2, amount: '1000' });
      const winners = [await approvedSubmission(bountyId), await approvedSubmission(bountyId)];
      const firstPayout = deferred<string>();
      // park T1 right after its INSERT (at the PAYOUT_REQUESTED audit) — its 600 is allocated but invisible to T2 without the row locks
      const parked = deferred<void>();
      const release = deferred<void>();
      const parkingAuditService = {
        record: async (actor: string | undefined, act: string, type: string, id: string, runner?: unknown) => {
          if (act === 'PAYOUT_REQUESTED') { firstPayout.resolve(id); parked.resolve(); await release.promise; }
          return audit.record(actor, act, type, id, runner as never);
        },
      } as unknown as AuditService;
      const t1 = new RewardsService(db, nfts, parkingAuditService, testConfig()).requestPayout(rewardId, winners[0], '600', adminId);
      await parked.promise;
      const t2 = rewards.requestPayout(rewardId, winners[1], '600', adminId).then((r) => r, (err: Error) => err);
      await Promise.race([waitForLockWaiter(db, 'the second payout request to wait on the bounty/reward rows'), t2]);
      release.resolve();
      await expect(t1).resolves.toMatchObject({ id: await firstPayout.promise, status: 'REQUESTED' });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(BadRequestException);
      expect((outcome as Error).message).toBe('PAYOUT_EXCEEDS_AVAILABLE_REWARD');
      const allocated = await db.query<{ total: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS total FROM payout WHERE bounty_reward_id = $1`, [rewardId]);
      expect(allocated.rows[0].total).toBe('600');
    });

    it('a payout recorded with a hash whose deposit confirmation is still uncommitted: the shared per-hash lock makes it wait and then 409 TX_HASH_ALREADY_USED', async () => {
      const { bountyId, rewardId } = await openFunded();
      const payout = await rewards.requestPayout(rewardId, await approvedSubmission(bountyId), '1000', adminId);
      await rewards.markApproved(payout.id, approverId);
      const otherReward = await rewardOf(await createBounty({ amount: '10' }));
      const hash = fakeTxHash();

      const parking = parkingAudit('REWARD_DEPOSIT_CONFIRMED', otherReward);
      const t1 = new RewardsService(db, nfts, parking.service, testConfig()).confirmDeposit(otherReward, hash, '10', adminId);
      await parking.parked;
      // T1 holds pg_advisory_xact_lock(hashtext(hash)) with deposit_tx_hash written but invisible; without the shared key T2 would see no deposit
      const t2 = rewards.markPaid(payout.id, hash.toLowerCase(), adminId).then((r) => r, (err: Error) => err);
      await Promise.race([waitForLockWaiter(db, 'markPaid to wait on the per-hash advisory lock'), t2]);
      parking.release();
      await expect(t1).resolves.toMatchObject({ status: 'FUNDED' });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((outcome as Error).message).toBe('TX_HASH_ALREADY_USED');
      expect((await db.query<{ status: string; payout_tx_hash: string | null }>(`SELECT status, payout_tx_hash FROM payout WHERE id = $1`, [payout.id])).rows[0])
        .toEqual({ status: 'APPROVED', payout_tx_hash: null });
    });

    it('two admins approving the same payout at once: one APPROVED with its approver, the other 404; a single PAYOUT_APPROVED', async () => {
      const { bountyId, rewardId } = await openFunded();
      const payout = await rewards.requestPayout(rewardId, await approvedSubmission(bountyId), '1000', adminId);
      const thirdAdmin = await createUser(db, { isAdmin: true });
      const { fulfilled, rejected } = split(await Promise.allSettled([rewards.markApproved(payout.id, approverId), rewards.markApproved(payout.id, thirdAdmin)]));
      expect(fulfilled).toEqual([{ id: payout.id, status: 'APPROVED' }]);
      expect(rejected.map((e) => e.message)).toEqual(['PAYOUT_NOT_FOUND_OR_WRONG_STATUS']);
      const approvedBy = (await db.query<{ approved_by: string }>(`SELECT approved_by FROM payout WHERE id = $1`, [payout.id])).rows[0].approved_by;
      expect([approverId, thirdAdmin]).toContain(approvedBy);
      expect(await auditActions(db, 'payout', payout.id)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED']);
    });

    it('solo-operator mode (PAYOUT_ALLOW_SELF_APPROVAL=true): a self-approved payout cannot be approved a second time by another admin (404)', async () => {
      const solo = new RewardsService(db, nfts, audit, testConfig({ PAYOUT_ALLOW_SELF_APPROVAL: 'true' }));
      const { bountyId, rewardId } = await openFunded();
      const payout = await solo.requestPayout(rewardId, await approvedSubmission(bountyId), '1000', adminId);
      await expect(solo.markApproved(payout.id, adminId)).resolves.toEqual({ id: payout.id, status: 'APPROVED' });
      await expect(solo.markApproved(payout.id, approverId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
      expect((await db.query<{ approved_by: string; requested_by: string }>(`SELECT approved_by, requested_by FROM payout WHERE id = $1`, [payout.id])).rows[0])
        .toEqual({ approved_by: adminId, requested_by: adminId });
    });
  });
});
