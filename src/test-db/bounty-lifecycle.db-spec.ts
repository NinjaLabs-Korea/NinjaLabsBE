import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { auditActions, createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';
import { describeDb } from './describe-db';

/**
 * 바운티 생명주기 규칙을 실 Postgres 행으로 단언한다 (bounty-lifecycle.spec.ts / bounty-lifecycle.service.spec.ts의 옛 SQL 해석 mock 대체):
 * 전이표 49조합, 차단 사유 카운트가 세는 상태 집합, 취소 연쇄, 지원서 심사/지원 마감 규칙.
 * 상태 걷기와 경합은 bounty-rules.db-spec.ts, 탈퇴한 참가자는 lifecycle-withdrawn-participants.db-spec.ts가 이미 다룬다.
 */
describeDb('bounty lifecycle on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let bounties: BountyAdminService;
  let lifecycle: BountyLifecycleService;
  let rewards: RewardsService;
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
    lifecycle = new BountyLifecycleService();
    bounties = new BountyAdminService(db, audit, lifecycle, new RewardTokenResolver(config));
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
  const work = (n: number | string) => ({ submissionUrl: `https://x.test/work/${n}`, description: `revision ${n}` });

  /** 바운티 하나. `amount`가 있으면 보상 행(DEPOSIT_PENDING)이 함께 생긴다 */
  async function createBounty(options: { applicationRequired?: boolean; maxWinners?: number; amount?: string } = {}) {
    const { id } = await bounties.create(adminId, {
      title: unique('life-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: options.applicationRequired ?? false, submissionMode: 'DIRECT', maxWinners: options.maxWinners ?? 1,
      submissionDeadline: FUTURE(),
      reward: options.amount ? { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: options.amount } : undefined,
    });
    return id;
  }
  const rewardOf = async (bountyId: string) => (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
  const setStatus = (id: string, status: string, deadline = FUTURE()) =>
    db.query(`UPDATE bounty SET status = $2, submission_deadline = $3 WHERE id = $1`, [id, status, deadline]);
  const bountyRow = async (id: string) =>
    (await db.query<{ status: string; submission_deadline: Date; opened_at: Date | null; review_started_at: Date | null; completed_at: Date | null }>(
      `SELECT status, submission_deadline, opened_at, review_started_at, completed_at FROM bounty WHERE id = $1`, [id])).rows[0];
  /** 실제 행으로 계산한 차단 사유 (서비스가 쓰는 것과 같은 함수) */
  async function blockersOf(id: string) {
    const row = await bountyRow(id);
    return lifecycle.blockers(db, id, row);
  }
  const codes = (list: Array<{ code: string; count?: number }>) => list.map((item) => (item.count === undefined ? item.code : `${item.code}:${item.count}`));

  // ---- transition table ----
  const ALL = ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'];
  const ALLOWED: Array<[string, string, 'opened_at' | 'review_started_at' | 'completed_at' | undefined]> = [
    ['DRAFT', 'FUNDING_PENDING', undefined], ['DRAFT', 'OPEN', 'opened_at'], ['DRAFT', 'CANCELLED', undefined],
    ['FUNDING_PENDING', 'OPEN', 'opened_at'], ['FUNDING_PENDING', 'CANCELLED', undefined],
    ['OPEN', 'SUBMISSION_CLOSED', undefined], ['OPEN', 'CANCELLED', undefined],
    ['SUBMISSION_CLOSED', 'IN_REVIEW', 'review_started_at'], ['SUBMISSION_CLOSED', 'OPEN', 'opened_at'],
    ['IN_REVIEW', 'COMPLETED', 'completed_at'], ['IN_REVIEW', 'OPEN', 'opened_at'],
  ];
  const allowedKey = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
  const REFUSED = ALL.flatMap((from) => ALL.filter((to) => !allowedKey.has(`${from}->${to}`)).map((to) => [from, to] as const));

  it.each(ALLOWED)('%s -> %s moves the row, stamps %s on first entry, and writes BOUNTY_<to> to the audit log', async (from, to, stamp) => {
    const id = await createBounty();
    await setStatus(id, from);
    await expect(bounties.transition(id, to, adminId)).resolves.toEqual({ id, status: to });
    const row = await bountyRow(id);
    expect(row.status).toBe(to);
    for (const column of ['opened_at', 'review_started_at', 'completed_at'] as const) {
      if (column === stamp) expect(row[column]).toBeInstanceOf(Date);
      else expect(row[column]).toBeNull();
    }
    expect(await auditActions(db, 'bounty', id)).toContain(`BOUNTY_${to}`);
  });

  it.each(REFUSED)('%s -> %s is 400 INVALID_TRANSITION and writes nothing', async (from, to) => {
    const id = await createBounty({ applicationRequired: true });
    await setStatus(id, from);
    const before = await auditActions(db, 'bounty', id);
    await expect(bounties.transition(id, to, adminId)).rejects.toMatchObject({ status: 400, message: `INVALID_TRANSITION:${from}->${to}` });
    expect((await bountyRow(id)).status).toBe(from);
    expect(await auditActions(db, 'bounty', id)).toEqual(before);
  });

  // ---- blockers from real rows ----
  describe('blocker counts', () => {
    it('OPEN: an expired deadline (DEADLINE_PASSED) and unconfirmed reward deposits (REWARDS_UNFUNDED, counted per reward) block, a confirmed deposit does not', async () => {
      const id = await createBounty({ amount: '100' });
      await setStatus(id, 'SUBMISSION_CLOSED', new Date(Date.now() - 60_000).toISOString());
      expect(codes((await blockersOf(id)).blockerDetails.OPEN)).toEqual(['DEADLINE_PASSED', 'REWARDS_UNFUNDED:1']);
      await setStatus(id, 'SUBMISSION_CLOSED');
      await rewards.confirmDeposit(await rewardOf(id), fakeTxHash(), '100', adminId);
      expect(codes((await blockersOf(id)).blockerDetails.OPEN)).toEqual([]);
      // a bounty without any reward row is never "unfunded"
      expect(codes((await blockersOf(await createBounty())).blockerDetails.OPEN)).toEqual([]);
    });

    it('unresolved submissions count exactly SUBMITTED, RESUBMITTED, IN_REVIEW and REVISION_REQUESTED; finished ones and other bounties do not', async () => {
      const id = await createBounty({ maxWinners: 9 });
      const elsewhere = await createBounty();
      await setStatus(id, 'OPEN');
      await setStatus(elsewhere, 'OPEN');
      for (const status of ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN']) {
        const user = await createUser(db);
        const sub = await submissions.submit(id, user, work(status));
        await db.query(`UPDATE bounty_submission SET status = $2 WHERE id = $1`, [sub.id, status]);
      }
      await submissions.submit(elsewhere, await createUser(db), work('other'));
      const { blockers, blockerDetails } = await blockersOf(id);
      expect(codes(blockerDetails.COMPLETED)).toContain('UNRESOLVED_SUBMISSIONS:4');
      expect(blockers.COMPLETED).toContain('Finish 4 submission review(s), including requested revisions.');
    });

    it('UNPAID_WINNERS counts open payouts (REQUESTED, AWAITING_MULTISIG_APPROVAL, APPROVED, BROADCASTING) and not PAID, FAILED or CANCELLED ones - for COMPLETED and CANCELLED alike', async () => {
      const id = await createBounty({ amount: '1000' });
      await rewards.confirmDeposit(await rewardOf(id), fakeTxHash(), '1000', adminId);
      const user = await createUser(db);
      await createPrimaryWallet(db, user);
      await setStatus(id, 'OPEN');
      const submission = await submissions.submit(id, user, work(1));
      await setStatus(id, 'IN_REVIEW');
      await db.query(`UPDATE bounty_submission SET status = 'APPROVED' WHERE id = $1`, [submission.id]);
      const payout = await rewards.requestPayout(await rewardOf(id), submission.id, '1000', adminId);

      const unpaidFor = async (status: string) => {
        await db.query(`UPDATE payout SET status = $2 WHERE id = $1`, [payout.id, status]);
        const { blockerDetails } = await blockersOf(id);
        expect(codes(blockerDetails.CANCELLED)).toEqual(codes(blockerDetails.COMPLETED).filter((code) => code === 'UNPAID_WINNERS'));
        return codes(blockerDetails.COMPLETED).includes('UNPAID_WINNERS');
      };
      for (const open of ['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING']) expect([open, await unpaidFor(open)]).toEqual([open, true]);
      expect(['PAID', await unpaidFor('PAID')]).toEqual(['PAID', false]);
      // a FAILED payout leaves the winner owed (the money never went out): still blocks; a CANCELLED one releases the award
      expect(['FAILED', await unpaidFor('FAILED')]).toEqual(['FAILED', true]);
      expect(['CANCELLED', await unpaidFor('CANCELLED')]).toEqual(['CANCELLED', false]);
    });

    it('an approved winner with no payout requested yet is owed while the pool has room and the account exists; not when the pool is spent, the reward is unfunded or the account is gone', async () => {
      const id = await createBounty({ amount: '1000' });
      const rewardId = await rewardOf(id);
      await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
      await setStatus(id, 'OPEN');
      const user = await createUser(db);
      await createPrimaryWallet(db, user);
      const submission = await submissions.submit(id, user, work(1));
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      await setStatus(id, 'IN_REVIEW');
      const owed = async () => codes((await blockersOf(id)).blockerDetails.COMPLETED).includes('UNPAID_WINNERS');

      expect(await owed()).toBe(true);
      await db.query(`UPDATE bounty_reward SET deposited_amount = 0 WHERE id = $1`, [rewardId]); // nothing left to allocate
      expect(await owed()).toBe(false);
      await db.query(`UPDATE bounty_reward SET deposited_amount = 1000, status = 'DEPOSIT_PENDING' WHERE id = $1`, [rewardId]); // not payable yet
      expect(await owed()).toBe(false);
      await db.query(`UPDATE bounty_reward SET status = 'FUNDED' WHERE id = $1`, [rewardId]);
      expect(await owed()).toBe(true);
      // a winner without a connected wallet can reconnect and still be paid: still owed
      await db.query(`UPDATE wallet SET disconnected_at = now() WHERE user_id = $1`, [user]);
      expect(await owed()).toBe(true);
      // a winner who withdrew the account can never be paid (requestPayout would 404): nothing is owed
      await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [user]);
      expect(await owed()).toBe(false);
    });

    it('PENDING applications block closing and completing (counted per bounty); only PENDING counts', async () => {
      const id = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      const elsewhere = await createBounty({ applicationRequired: true });
      await setStatus(elsewhere, 'OPEN');
      await applications.apply(elsewhere, await createUser(db), 'elsewhere');
      const pending = await applications.apply(id, await createUser(db), 'hi');
      const rejected = await applications.apply(id, await createUser(db), 'hi');
      await applicationReview.review(rejected.id, 'REJECTED', 'no', adminId);

      const { blockerDetails, blockers } = await blockersOf(id);
      expect(codes(blockerDetails.SUBMISSION_CLOSED)).toEqual(['PENDING_APPLICATIONS:1']);
      expect(codes(blockerDetails.COMPLETED)).toContain('PENDING_APPLICATIONS:1');
      expect(blockers.SUBMISSION_CLOSED).toEqual(['Review 1 pending application(s) before closing submissions.']);
      await applicationReview.review(pending.id, 'APPROVED', undefined, adminId);
      expect(codes((await blockersOf(id)).blockerDetails.SUBMISSION_CLOSED)).toEqual(['UNSUBMITTED_PARTICIPANTS:1']);
    });

    it('nothing ever blocks IN_REVIEW, and the blockers of other targets do not block this move (SUBMISSION_CLOSED -> IN_REVIEW with pending and unresolved work)', async () => {
      const id = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      await applications.apply(id, await createUser(db), 'hi'); // pending
      await setStatus(id, 'SUBMISSION_CLOSED');
      await db.query(`INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status) VALUES ($1, $2, 'https://x.test/u', 'd', 'SUBMITTED')`, [id, await createUser(db)]);
      expect((await blockersOf(id)).blockerDetails.IN_REVIEW).toEqual([]);
      await expect(bounties.transition(id, 'IN_REVIEW', adminId)).resolves.toEqual({ id, status: 'IN_REVIEW' });
      // …while the target's own blockers are the 400 body, in full
      await expect(bounties.transition(id, 'COMPLETED', adminId)).rejects.toMatchObject({
        status: 400,
        response: { message: ['Resolve 1 pending application(s).', 'Finish 1 submission review(s), including requested revisions.'] },
      });
      expect((await bountyRow(id)).status).toBe('IN_REVIEW');
    });

    it('a deadline passing flips OPEN blocking and releases the "unsubmitted participants" wait (the deadline is compared against now())', async () => {
      const id = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      const application = await applications.apply(id, await createUser(db), 'hi');
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
      expect(codes((await blockersOf(id)).blockerDetails.SUBMISSION_CLOSED)).toEqual(['UNSUBMITTED_PARTICIPANTS:1']);
      await setStatus(id, 'OPEN', new Date(Date.now() - 1_000).toISOString());
      const after = await blockersOf(id);
      expect(codes(after.blockerDetails.SUBMISSION_CLOSED)).toEqual([]);
      expect(codes(after.blockerDetails.OPEN)).toEqual(['DEADLINE_PASSED']);
    });
  });

  // ---- cancel ----
  describe('cancelling', () => {
    it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('%s is not blocked by intake, review or funding counts (only owed winners block CANCELLED)', async (from) => {
      const id = await createBounty({ applicationRequired: true, amount: '100' }); // unfunded reward
      await setStatus(id, 'OPEN');
      await applications.apply(id, await createUser(db), 'pending');
      await db.query(`INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status) VALUES ($1, $2, 'https://x.test/u', 'd', 'IN_REVIEW')`, [id, await createUser(db)]);
      await setStatus(id, from, new Date(Date.now() - 60_000).toISOString());
      await expect(bounties.transition(id, 'CANCELLED', adminId)).resolves.toEqual({ id, status: 'CANCELLED' });
    });

    it('is refused while an approved winner is still owed (after a reopen from review): the UNPAID_WINNERS sentence, row untouched; allowed once paid', async () => {
      const id = await createBounty({ amount: '1000' });
      const rewardId = await rewardOf(id);
      await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
      await setStatus(id, 'OPEN');
      const user = await createUser(db);
      await createPrimaryWallet(db, user);
      const submission = await submissions.submit(id, user, work(1));
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);

      const refused = { status: 400, response: { message: ['Record completed payments for all approved winners and finish every pending payout.'] } };
      await expect(bounties.transition(id, 'CANCELLED', adminId)).rejects.toMatchObject(refused); // unawarded (no payout yet)
      const payout = await rewards.requestPayout(rewardId, submission.id, '1000', adminId);
      await expect(bounties.transition(id, 'CANCELLED', adminId)).rejects.toMatchObject(refused); // open payout
      expect((await bountyRow(id)).status).toBe('OPEN');
      expect(await auditActions(db, 'bounty', id)).not.toContain('BOUNTY_CANCELLED');
      await rewards.markApproved(payout.id, approverId);
      await rewards.markPaid(payout.id, fakeTxHash(), adminId);
      await expect(bounties.transition(id, 'CANCELLED', adminId)).resolves.toEqual({ id, status: 'CANCELLED' });
    });

    it('rejects only the PENDING applications of this bounty (reviewer recorded, note cleared, no APPLICATION_* audit rows); approved, rejected, withdrawn and other bounties stay', async () => {
      const id = await createBounty({ applicationRequired: true });
      const other = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      await setStatus(other, 'OPEN');
      const pending = await applications.apply(id, await createUser(db), 'pending');
      const approved = await applications.apply(id, await createUser(db), 'approved');
      await applicationReview.review(approved.id, 'APPROVED', 'welcome', adminId);
      const rejected = await applications.apply(id, await createUser(db), 'rejected');
      await applicationReview.review(rejected.id, 'REJECTED', 'no', adminId);
      const withdrawerId = await createUser(db);
      const withdrawn = await applications.apply(id, withdrawerId, 'withdrawn');
      await db.query(`UPDATE bounty_application SET status = 'WITHDRAWN' WHERE id = $1`, [withdrawn.id]);
      const elsewhere = await applications.apply(other, await createUser(db), 'elsewhere');
      const auditBefore = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'APPLICATION\\_%'`);

      await bounties.transition(id, 'CANCELLED', adminId);

      const rows = await db.query<{ id: string; status: string; reviewed_by: string | null; review_note: string | null; reviewed_at: Date | null }>(
        `SELECT id, status, reviewed_by, review_note, reviewed_at FROM bounty_application WHERE id = ANY($1::uuid[])`,
        [[pending.id, approved.id, rejected.id, withdrawn.id, elsewhere.id]]);
      const by = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
      expect(by[pending.id]).toMatchObject({ status: 'REJECTED', reviewed_by: adminId, review_note: null });
      expect(by[pending.id].reviewed_at).toBeInstanceOf(Date);
      expect(by[approved.id]).toMatchObject({ status: 'APPROVED', review_note: 'welcome' });
      expect(by[rejected.id]).toMatchObject({ status: 'REJECTED', review_note: 'no' });
      expect(by[withdrawn.id].status).toBe('WITHDRAWN');
      expect(by[elsewhere.id].status).toBe('PENDING');
      const auditAfter = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'APPLICATION\\_%'`);
      expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
    });

    it.each([['OPEN', 'SUBMISSION_CLOSED'], ['SUBMISSION_CLOSED', 'IN_REVIEW'], ['IN_REVIEW', 'COMPLETED']])('a move %s -> %s leaves applications and submissions alone (only cancelling cascades)', async (from, to) => {
      const id = await createBounty({ applicationRequired: false });
      await setStatus(id, 'OPEN');
      const sub = await submissions.submit(id, await createUser(db), work(1));
      await db.query(`UPDATE bounty_submission SET status = 'APPROVED' WHERE id = $1`, [sub.id]); // keep every blocker quiet
      await setStatus(id, from);
      await bounties.transition(id, to, adminId);
      expect((await db.query(`SELECT status FROM bounty_submission WHERE id = $1`, [sub.id])).rows[0].status).toBe('APPROVED');
      expect((await db.query(`SELECT 1 FROM submission_review WHERE submission_id = $1`, [sub.id])).rowCount).toBe(0);
    });
  });

  // ---- reopening ----
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('reopens %s with a future deadline and keeps the first opening time; with an expired deadline it is refused with the extend-the-deadline sentence', async (status) => {
    const id = await createBounty();
    await bounties.transition(id, 'OPEN', adminId);
    const firstOpened = (await bountyRow(id)).opened_at!;
    await setStatus(id, status);
    await expect(bounties.transition(id, 'OPEN', adminId)).resolves.toEqual({ id, status: 'OPEN' });
    expect((await bountyRow(id)).opened_at!.getTime()).toBe(firstOpened.getTime());

    await setStatus(id, status, new Date(Date.now() - 60_000).toISOString());
    await expect(bounties.transition(id, 'OPEN', adminId)).rejects.toMatchObject({ response: { message: ['Extend the submission deadline before opening this bounty.'] } });
    expect((await bountyRow(id)).status).toBe(status);
  });

  // ---- reviews and applying around the deadline ----
  describe('application review and applying', () => {
    async function applicationOn(status: string, deadline = FUTURE()) {
      const id = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      const application = await applications.apply(id, await createUser(db), 'hi');
      await setStatus(id, status, deadline);
      return { id, application };
    }

    it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('in %s an application can be rejected but not approved (APPLICATION_APPROVAL_CLOSED: it would be stranded)', async (status) => {
      const { application } = await applicationOn(status);
      await expect(applicationReview.review(application.id, 'APPROVED', undefined, adminId)).rejects.toMatchObject({ status: 400, message: 'APPLICATION_APPROVAL_CLOSED' });
      await expect(applicationReview.review(application.id, 'REJECTED', 'Intake ended', adminId)).resolves.toMatchObject({ status: 'REJECTED' });
      expect((await db.query(`SELECT review_note, reviewed_by FROM bounty_application WHERE id = $1`, [application.id])).rows[0]).toEqual({ review_note: 'Intake ended', reviewed_by: adminId });
    });

    it('an OPEN bounty past its submission deadline cannot approve either, but a future one can', async () => {
      const expired = await applicationOn('OPEN', new Date(Date.now() - 60_000).toISOString());
      await expect(applicationReview.review(expired.application.id, 'APPROVED', undefined, adminId)).rejects.toMatchObject({ message: 'APPLICATION_APPROVAL_CLOSED' });
      const live = await applicationOn('OPEN');
      await expect(applicationReview.review(live.application.id, 'APPROVED', undefined, adminId)).resolves.toMatchObject({ status: 'APPROVED' });
    });

    it.each(['COMPLETED', 'CANCELLED'])('a %s bounty takes no application review at all (BOUNTY_REVIEW_CLOSED)', async (status) => {
      const { application } = await applicationOn(status);
      for (const decision of ['APPROVED', 'REJECTED'] as const) {
        await expect(applicationReview.review(application.id, decision, undefined, adminId)).rejects.toMatchObject({ message: 'BOUNTY_REVIEW_CLOSED' });
      }
      expect((await db.query(`SELECT status FROM bounty_application WHERE id = $1`, [application.id])).rows[0].status).toBe('PENDING');
    });

    it.each(['submission_deadline', 'application_deadline'])('new applications are refused after the %s (APPLICATION_DEADLINE_PASSED), and nothing is written', async (field) => {
      const id = await createBounty({ applicationRequired: true });
      await setStatus(id, 'OPEN');
      await db.query(`UPDATE bounty SET ${field} = now() - interval '1 minute' WHERE id = $1`, [id]);
      await expect(applications.apply(id, await createUser(db), 'late')).rejects.toMatchObject({ status: 400, message: 'APPLICATION_DEADLINE_PASSED' });
      expect((await db.query(`SELECT 1 FROM bounty_application WHERE bounty_id = $1`, [id])).rowCount).toBe(0);
    });
  });
});
