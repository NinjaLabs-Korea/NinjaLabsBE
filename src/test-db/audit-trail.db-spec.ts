import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { runWithRequestContext } from '../common/http/request-context';
import { RewardsService } from '../rewards/rewards.service';
import { maskAddress } from '../common/validation/injective-address';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique, setPayoutAddress, withPayoutAddresses } from './harness';

/**
 * 2026-11-02 감사 공백 보강을 실 Postgres 행으로 고정한다:
 * - 지원·제출의 감사 행이 같은 트랜잭션에서 생기고, 그 뒤 실패하면 본 작업과 함께 롤백된다
 * - 돈 감사 행(입금 확인, 지급 요청·승인·지급)의 after_data에 금액·해시가 들어간다
 * - ip_address는 요청 컨텍스트(req.ip)가 있을 때만 채워진다
 *
 * 롤백 단언은 "감사 INSERT는 성공하고 바로 뒤에 던지는" AuditService로 한다: 감사 행이 tx가 아니라 pool로 나갔다면
 * 롤백 뒤에도 행이 남는다.
 */
describeDb('audit trail rows on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;
  let approverId: string;

  /** 감사 INSERT를 tx에 쓴 직후 던진다 - 본 작업과 감사 행이 둘 다 사라져야 한다 */
  class FailAfterInsertAudit extends AuditService {
    override async record(...args: Parameters<AuditService['record']>): Promise<void> {
      await super.record(...args);
      throw new Error('fail after audit insert');
    }
  }

  beforeAll(async () => {
    db = createDb();
    audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = withPayoutAddresses(db, new RewardsService(db, audit, config));
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db, audit);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  type AuditRow = {
    action: string; actor_user_id: string | null; actor_agent_id: string | null;
    before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; ip: string | null;
  };
  const auditRows = async (entityType: string, entityId: string) =>
    (await db.query<AuditRow>(
      `SELECT action, actor_user_id, actor_agent_id, before_data, after_data, host(ip_address) AS ip
         FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, action`,
      [entityType, entityId],
    )).rows;
  const auditCountFor = async (action: string, bountyId: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND after_data->>'bountyId' = $2`, [action, bountyId])).rows[0].n;

  async function bounty(options: { applicationRequired?: boolean; reward?: string } = {}) {
    const { id } = await bounties.create(adminId, {
      title: unique('audit-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: options.applicationRequired ?? false, maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ...(options.reward ? { reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: options.reward } } : {}),
    });
    if (!options.reward) await db.query(`UPDATE bounty SET status = 'OPEN' WHERE id = $1`, [id]);
    return id;
  }
  const work = (n: number) => ({ submissionUrl: `https://x.test/work/${n}`, description: `revision ${n}` });

  describe('applications', () => {
    it('a person application is audited with actor_user_id, and the request IP when it came through HTTP', async () => {
      const bountyId = await bounty({ applicationRequired: true });
      const userId = await createUser(db);
      const app = await runWithRequestContext('203.0.113.9', () => applications.apply(bountyId, userId, 'hi'));
      expect(await auditRows('bounty_application', app.id)).toEqual([
        expect.objectContaining({ action: 'APPLICATION_SUBMITTED', actor_user_id: userId, actor_agent_id: null, ip: '203.0.113.9' }),
      ]);
    });

    it('an application rolls back together with its audit row when the transaction fails after the insert', async () => {
      const bountyId = await bounty({ applicationRequired: true });
      const userId = await createUser(db);
      const failing = new ApplicationsService(db, new FailAfterInsertAudit(db));
      await expect(failing.apply(bountyId, userId, 'hi')).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT 1 FROM bounty_application WHERE bounty_id = $1`, [bountyId])).rowCount).toBe(0);
      expect(await auditCountFor('APPLICATION_SUBMITTED', bountyId)).toBe(0);
    });

    it('withdrawing audits APPLICATION_WITHDRAWN as the person, and a failure keeps the application PENDING', async () => {
      const bountyId = await bounty({ applicationRequired: true });
      const ownerId = await createUser(db);
      const app = await applications.apply(bountyId, ownerId, 'hi');
      await expect(new ApplicationsService(db, new FailAfterInsertAudit(db)).withdraw(app.id, ownerId)).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT status FROM bounty_application WHERE id = $1`, [app.id])).rows[0].status).toBe('PENDING');
      expect((await auditRows('bounty_application', app.id)).map((row) => row.action)).toEqual(['APPLICATION_SUBMITTED']);

      await applications.withdraw(app.id, ownerId);
      expect((await auditRows('bounty_application', app.id)).find((row) => row.action === 'APPLICATION_WITHDRAWN')).toEqual({
        action: 'APPLICATION_WITHDRAWN', actor_user_id: ownerId, actor_agent_id: null,
        before_data: { status: 'PENDING' }, after_data: { status: 'WITHDRAWN', bountyId }, ip: null,
      });
    });
  });

  describe('submissions', () => {
    it('a submission and resubmission leave SUBMISSION_SUBMITTED / SUBMISSION_RESUBMITTED with actor_user_id and revision numbers, no URL or description', async () => {
      const bountyId = await bounty({ applicationRequired: true });
      const userId = await createUser(db);
      const app = await applications.apply(bountyId, userId, 'hi');
      await applicationReview.review(app.id, 'APPROVED', undefined, adminId);
      const first = await submissions.submit(bountyId, userId, work(1));
      await submissions.submit(bountyId, userId, work(2));
      const rows = await auditRows('bounty_submission', first.id);
      expect(rows).toEqual([
        { action: 'SUBMISSION_SUBMITTED', actor_user_id: userId, actor_agent_id: null, before_data: null, after_data: { status: 'SUBMITTED', revisionNo: 1, bountyId }, ip: null },
        { action: 'SUBMISSION_RESUBMITTED', actor_user_id: userId, actor_agent_id: null,
          before_data: { status: 'SUBMITTED', revisionNo: 1 }, after_data: { status: 'RESUBMITTED', revisionNo: 2, bountyId }, ip: null },
      ]);
      expect(JSON.stringify(rows)).not.toContain('x.test');
    });

    it('a failure after the audit insert rolls back the first submission and its revision', async () => {
      const bountyId = await bounty();
      const userId = await createUser(db);
      await expect(new SubmissionsService(db, new FailAfterInsertAudit(db)).submit(bountyId, userId, work(1))).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT 1 FROM bounty_submission WHERE bounty_id = $1`, [bountyId])).rowCount).toBe(0);
      expect(await auditCountFor('SUBMISSION_SUBMITTED', bountyId)).toBe(0);
    });

    it('a failure after the audit insert rolls back a resubmission (revision stays 1)', async () => {
      const bountyId = await bounty();
      const userId = await createUser(db);
      const first = await submissions.submit(bountyId, userId, work(1));
      await expect(new SubmissionsService(db, new FailAfterInsertAudit(db)).submit(bountyId, userId, work(2))).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT status, current_revision_no FROM bounty_submission WHERE id = $1`, [first.id])).rows[0]).toEqual({ status: 'SUBMITTED', current_revision_no: 1 });
      expect((await auditRows('bounty_submission', first.id)).map((row) => row.action)).toEqual(['SUBMISSION_SUBMITTED']);
    });
  });

  describe('money rows carry amount and hash', () => {
    const normalized = (hash: string) => `0x${hash.slice(2).toLowerCase()}`;

    async function fundedWithWinner() {
      const bountyId = await bounty({ reward: '1000' });
      const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
      const depositHash = fakeTxHash();
      await rewards.confirmDeposit(rewardId, depositHash, '1200', adminId);
      await bounties.transition(bountyId, 'OPEN', adminId);
      const winner = await createUser(db);
      const wallet = await createPrimaryWallet(db, winner);
      const submission = await submissions.submit(bountyId, winner, work(1));
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      const entered = await setPayoutAddress(db, submission.id);
      return { bountyId, rewardId, depositHash, walletId: wallet.id, submissionId: submission.id, entered };
    }

    it('deposit, request, approval and paid rows record status, amounts, normalized hashes and ids, never a raw wallet or payout address', async () => {
      const { bountyId, rewardId, depositHash, walletId, submissionId, entered } = await fundedWithWinner();
      expect(await auditRows('bounty_reward', rewardId)).toEqual([expect.objectContaining({
        action: 'REWARD_DEPOSIT_CONFIRMED', actor_user_id: adminId,
        before_data: { status: 'DEPOSIT_PENDING' }, after_data: { status: 'FUNDED', txHash: normalized(depositHash), depositedAmount: '1200', bountyId },
      })]);

      const payout = await runWithRequestContext('198.51.100.20', () => rewards.requestPayout(rewardId, submissionId, '1000', adminId));
      await rewards.markApproved(payout.id, approverId);
      const paidHash = fakeTxHash();
      const paid = await rewards.markPaid(payout.id, paidHash, approverId);
      expect(paid).not.toHaveProperty('amount'); // response shape unchanged

      const rows = await auditRows('payout', payout.id);
      expect(rows).toEqual([
        { action: 'PAYOUT_REQUESTED', actor_user_id: adminId, actor_agent_id: null, before_data: null,
          after_data: { status: 'REQUESTED', amount: '1000', rewardId, submissionId, recipientAddress: maskAddress(entered) }, ip: '198.51.100.20' },
        { action: 'PAYOUT_APPROVED', actor_user_id: approverId, actor_agent_id: null, before_data: { status: 'REQUESTED' },
          after_data: { status: 'APPROVED', amount: '1000', requestedBy: adminId }, ip: null },
        { action: 'PAYOUT_PAID', actor_user_id: approverId, actor_agent_id: null, before_data: { status: 'APPROVED' },
          after_data: { status: 'PAID', txHash: normalized(paidHash), amount: '1000' }, ip: null },
      ]);
      const address = (await db.query<{ address: string }>(`SELECT address FROM wallet WHERE id = $1`, [walletId])).rows[0].address;
      expect(JSON.stringify(rows)).not.toContain(address);
      expect(JSON.stringify(rows)).not.toContain(entered); // only the masked form (first 6 + last 4)
    });

    it('a PAYOUT_PAID txHash in after_data is not mistaken for a refund hash (only REWARD_REFUNDED rows count)', async () => {
      const first = await fundedWithWinner();
      const payout = await rewards.requestPayout(first.rewardId, first.submissionId, '1000', adminId);
      await rewards.markApproved(payout.id, approverId);
      const hash = fakeTxHash();
      await rewards.markPaid(payout.id, hash, adminId);
      // the same hash on a second payout of the same bounty is still allowed (multi-recipient send), so no refund-hash 409
      const extra = await createUser(db);
      await createPrimaryWallet(db, extra);
      await db.query(`UPDATE bounty SET max_winners = 2 WHERE id = $1`, [first.bountyId]);
      await db.query(`UPDATE bounty_reward SET amount = 2000, deposited_amount = 2000 WHERE id = $1`, [first.rewardId]);
      const sub = await submissions.submit(first.bountyId, extra, work(1));
      await submissionReview.review(sub.id, 'APPROVE', undefined, adminId);
      const second = await rewards.requestPayout(first.rewardId, sub.id, '500', adminId);
      await rewards.markApproved(second.id, approverId);
      await expect(rewards.markPaid(second.id, hash, adminId)).resolves.toMatchObject({ status: 'PAID' });
    });

    it('a failure after the PAYOUT_PAID insert rolls back the payment: payout stays APPROVED, no hash, no PAYOUT_PAID row', async () => {
      const { rewardId, submissionId } = await fundedWithWinner();
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await rewards.markApproved(payout.id, approverId);
      const failing = withPayoutAddresses(db, new RewardsService(db, new FailAfterInsertAudit(db), testConfig()));
      await expect(failing.markPaid(payout.id, fakeTxHash(), adminId)).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT status, payout_tx_hash FROM payout WHERE id = $1`, [payout.id])).rows[0]).toEqual({ status: 'APPROVED', payout_tx_hash: null });
      expect((await auditRows('payout', payout.id)).map((row) => row.action)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED']);
    });

    it('a failure after the REWARD_DEPOSIT_CONFIRMED insert leaves the reward DEPOSIT_PENDING with no hash', async () => {
      const bountyId = await bounty({ reward: '1000' });
      const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
      const failing = withPayoutAddresses(db, new RewardsService(db, new FailAfterInsertAudit(db), testConfig()));
      await expect(failing.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId)).rejects.toThrow('fail after audit insert');
      expect((await db.query(`SELECT status, deposit_tx_hash FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0]).toEqual({ status: 'DEPOSIT_PENDING', deposit_tx_hash: null });
      expect(await auditRows('bounty_reward', rewardId)).toEqual([]);
    });
  });
});
