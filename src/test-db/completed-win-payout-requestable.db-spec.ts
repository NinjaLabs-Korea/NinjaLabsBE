import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { HighlightsService } from '../highlights/highlights.service';
import { NftsService } from '../nfts/nfts.service';
import { MINTED_OR_LATER, sqlIn } from '../nfts/nft-status';
import { PAYABLE_REWARD_STATUSES, payoutRequestableSql, payoutStatusSql } from '../rewards/payout-status';
import { RewardsService } from '../rewards/rewards.service';
import { PENDING_REWARD_SQL } from '../users/account-withdrawal.service';
import { UsersService } from '../users/users.service';
import { BountyStatusPolicy } from '../bounties/bounty-status';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';

// AgentsService가 끌어오는 ESM 전용 SDK는 e2e 스텁으로 바꾼다 (agents.db-spec.ts와 같다). 여기서는 myAgents 조회만 쓴다.
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

/**
 * 돈·공개 집계 경로의 단일 출처 조각이 이전 SQL과 같은 결과를 내는지 실제 행으로 고정한다.
 *
 * 1. 완료된 수상(completedWinSql)/완료된 바운티(completedBountySql): 옮기기 전 문장(아래 OLD_*, 이 PR 직전 main의 SQL 사본)과
 *    지금 서비스가 같은 결과를 낸다. 본인·에이전트 x APPROVED/REJECTED/SUBMITTED x 삭제/미삭제 x OPEN/COMPLETED x PAID 유무 조합.
 *    사본은 이 비교를 위해서만 둔다: 규칙을 일부러 바꿀 때는 이 사본을 지운다.
 * 2. 지급 요청 가능(payoutRequestableSql): SQL 술어가 참인 것과 requestPayout(금액 1)이 받아 주는 것이 시나리오마다 같고,
 *    탈퇴 차단 PENDING_REWARD_SQL과 지급 상태 payoutStatusSql도 같은 답을 낸다.
 */
describeDb('completed wins and payout requestability single sources on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  describe('completed wins: same rows as the pre-refactor SQL', () => {
    const OLD_PROFILE_COMPLETED = `SELECT b.id, b.title, b.category, s.reviewed_at AS completed_at,
              COALESCE(json_agg(json_build_object(
                'amount', p.amount::text,
                'symbol', r.display_symbol
              ) ORDER BY p.paid_at) FILTER (WHERE p.id IS NOT NULL), '[]') AS rewards,
              COALESCE((SELECT json_agg(json_build_object('amount', rw.amount::text, 'symbol', rw.display_symbol) ORDER BY rw.created_at)
                          FROM bounty_reward rw WHERE rw.bounty_id = b.id), '[]') AS "postedRewards",
              ${payoutStatusSql('s', 'b')} AS "payoutStatus"
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id
         LEFT JOIN payout p ON p.submission_id = s.id AND p.status = 'PAID'
         LEFT JOIN bounty_reward r ON r.id = p.bounty_reward_id
        WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL
          AND (s.submitter_user_id = $1
               OR s.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL)))
        GROUP BY s.id, b.id
        ORDER BY s.reviewed_at DESC, s.id`;
    const OLD_PROFILE_AGENTS = `SELECT a.id, a.name, a.description, a.status, a.wallet_address,
              COALESCE(json_agg(json_build_object('id', b.id, 'title', b.title) ORDER BY s.reviewed_at DESC, b.id)
                       FILTER (WHERE b.id IS NOT NULL), '[]') AS completed_bounties
         FROM agent a
         LEFT JOIN bounty_submission s ON s.agent_id = a.id AND s.status = 'APPROVED'
         LEFT JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
        GROUP BY a.id
        ORDER BY a.created_at, a.id`;
    const OLD_MY_AGENT_COUNT = `SELECT a.id, (SELECT count(*)::int FROM bounty_submission s
                 JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL
                WHERE s.agent_id = a.id AND s.status = 'APPROVED') AS completed_bounties
         FROM agent a WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`;
    const OLD_HOF_COUNTS = `SELECT
         (SELECT count(*) FROM bounty
           WHERE status = 'COMPLETED' AND deleted_at IS NULL) AS completed_bounties,
         (SELECT count(DISTINCT COALESCE(s.submitter_user_id, s.agent_id)) FROM bounty_submission s
            JOIN bounty b ON b.id = s.bounty_id
           WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL
             AND (b.status = 'COMPLETED'
                  OR EXISTS (SELECT 1 FROM payout p WHERE p.submission_id = s.id AND p.status = 'PAID'))) AS builders,
         (SELECT count(*) FROM nft n
            JOIN bounty b ON b.id = n.bounty_id
           WHERE n.nft_type = 'BOUNTY_COMPLETION_CHILD'
             AND n.status ${sqlIn(MINTED_OR_LATER)}
             AND b.deleted_at IS NULL) AS completion_nfts,
         (SELECT count(DISTINCT lower(btrim(sponsor_name))) FROM bounty
           WHERE status = 'COMPLETED' AND deleted_at IS NULL) AS sponsors`;

    it('public profile, my agents and hall-of-fame counts match the old SQL across every status / deletion / payment combination', async () => {
      const nickname = unique('cw').slice(0, 20);
      const owner = await createUser(db, { nickname });
      const wallet = await createPrimaryWallet(db, owner);
      const agentIds: string[] = [];
      for (const status of ['ACTIVE', 'ACTIVE']) {
        agentIds.push((await db.query<{ id: string }>(
          `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
           VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
          [owner, unique('bot-'), `pk-${unique()}`, `inj1${unique()}`, status])).rows[0].id);
      }
      const actors: Array<{ user?: string; agent?: string }> = [{ user: owner }, { agent: agentIds[0] }, { agent: agentIds[1] }];
      let n = 0;
      for (const actor of actors) {
        for (const subStatus of ['APPROVED', 'REJECTED', 'SUBMITTED']) {
          for (const deleted of [false, true]) {
            for (const bountyStatus of ['OPEN', 'COMPLETED']) {
              for (const paid of [false, true]) {
                n++;
                const bountyId = (await db.query<{ id: string }>(
                  `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, status, opened_at, deleted_at)
                   VALUES ($1, $2, $3, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', $4, now(), CASE WHEN $5::boolean THEN now() END) RETURNING id`,
                  [adminId, unique('sp-'), unique('cw-'), bountyStatus, deleted])).rows[0].id;
                const rewardId = (await db.query<{ id: string }>(
                  `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, status, custody_address)
                   VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 1000, 'FUNDED', 'inj1custody') RETURNING id`, [bountyId])).rows[0].id;
                const submissionId = (await db.query<{ id: string }>(
                  `INSERT INTO bounty_submission (bounty_id, submitter_user_id, agent_id, submission_url, description, status, reviewed_at)
                   VALUES ($1, $2, $3, 'https://example.test', 'd', $4, now() - make_interval(secs => $5::int)) RETURNING id`,
                  [bountyId, actor.user ?? null, actor.agent ?? null, subStatus, n])).rows[0].id;
                if (paid) {
                  await db.query(
                    `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, payout_tx_hash, paid_at)
                     VALUES ($1, $2, $3, 400, 'PAID', $4, $5, $6, now())`,
                    [rewardId, submissionId, wallet.id, unique('idem-'), adminId, fakeTxHash()]);
                }
              }
            }
          }
        }
      }

      const profile = await new UsersService(db, new AuditService(db)).publicProfile(nickname);
      const oldCompleted = (await db.query(OLD_PROFILE_COMPLETED, [owner])).rows;
      const oldAgents = (await db.query(OLD_PROFILE_AGENTS, [owner])).rows;
      expect(profile.completedBounties).toEqual(oldCompleted);
      expect(profile.completedBounties).toHaveLength(3 * 2 * 2); // 행위자 3 x APPROVED x 미삭제 x (OPEN, COMPLETED) x (미지급, 지급)
      expect(profile.agents).toEqual(oldAgents);
      expect(profile.agents.map((a: { completed_bounties: unknown[] }) => a.completed_bounties.length)).toEqual([4, 4]);

      const mine = await new AgentsService(db, new AuditService(db)).myAgents(owner);
      const oldCounts = (await db.query<{ id: string; completed_bounties: number }>(OLD_MY_AGENT_COUNT, [owner])).rows;
      expect(mine.map((a: { id: string; completed_bounties: number }) => ({ id: a.id, completed_bounties: a.completed_bounties }))).toEqual(oldCounts);

      const counts = await (new HighlightsService(db) as unknown as { computeCounts(): Promise<Record<string, number>> }).computeCounts();
      const old = (await db.query<Record<string, string>>(OLD_HOF_COUNTS)).rows[0];
      expect(counts).toEqual({
        completedBounties: Number(old.completed_bounties), builders: Number(old.builders),
        completionNfts: Number(old.completion_nfts), sponsors: Number(old.sponsors),
      });
    });
  });

  describe('payout requestable: SQL predicate, requestPayout, withdrawal block and payout status agree', () => {
    async function openFunded(options: { amount?: string; deposit?: string; maxWinners?: number } = {}) {
      const amount = options.amount ?? '1000';
      const { id: bountyId } = await bounties.create(adminId, {
        title: unique('req-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: options.maxWinners ?? 2,
        submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount },
      });
      const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
      await rewards.confirmDeposit(rewardId, fakeTxHash(), options.deposit ?? amount, adminId);
      await bounties.transition(bountyId, 'OPEN', adminId);
      return { bountyId, rewardId };
    }

    async function approvedWinner(bountyId: string) {
      const userId = await createUser(db);
      await createPrimaryWallet(db, userId);
      const submission = await submissions.submit(bountyId, userId, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      return { userId, submissionId: submission.id };
    }

    const setPayoutStatus = (rewardId: string, submissionId: string, status: string) =>
      db.query(`UPDATE payout SET status = $3 WHERE bounty_reward_id = $1 AND submission_id = $2`, [rewardId, submissionId, status]);

    const scenarios: Array<[string, (ctx: { rewardId: string; bountyId: string; submissionId: string; other: string }) => Promise<void>, { deposit?: string; requestable: boolean }]> = [
      ['fresh winner on a funded reward', async () => undefined, { requestable: true }],
      ['own payout was CANCELLED (pair already used)', async (c) => {
        await rewards.requestPayout(c.rewardId, c.submissionId, '10', adminId);
        await setPayoutStatus(c.rewardId, c.submissionId, 'CANCELLED');
      }, { requestable: false }],
      ['own payout FAILED', async (c) => {
        await rewards.requestPayout(c.rewardId, c.submissionId, '10', adminId);
        await setPayoutStatus(c.rewardId, c.submissionId, 'FAILED');
      }, { requestable: false }],
      ['another winner took the whole cap', async (c) => { await rewards.requestPayout(c.rewardId, c.other, '1000', adminId); }, { requestable: false }],
      ["another winner's full-cap payout was CANCELLED (cap freed)", async (c) => {
        await rewards.requestPayout(c.rewardId, c.other, '1000', adminId);
        await setPayoutStatus(c.rewardId, c.other, 'CANCELLED');
      }, { requestable: true }],
      ['over-deposit does not raise the cap (amount 1000, deposit 5000, other took 1000)', async (c) => {
        await rewards.requestPayout(c.rewardId, c.other, '1000', adminId);
      }, { deposit: '5000', requestable: false }],
      ['under the cap after a partial allocation', async (c) => { await rewards.requestPayout(c.rewardId, c.other, '999', adminId); }, { requestable: true }],
      ['reward back to DEPOSIT_PENDING (not payable)', async (c) => {
        await db.query(`UPDATE bounty_reward SET status = 'DEPOSIT_PENDING' WHERE id = $1`, [c.rewardId]);
      }, { requestable: false }],
    ];

    it.each(scenarios)('%s', async (_name, arrange, options) => {
      const { bountyId, rewardId } = await openFunded({ deposit: options.deposit });
      const winner = await approvedWinner(bountyId);
      const other = await approvedWinner(bountyId);
      await arrange({ rewardId, bountyId, submissionId: winner.submissionId, other: other.submissionId });

      const predicate = (await db.query<{ ok: boolean }>(
        `SELECT rw.status = ANY($3::text[]) AND ${payoutRequestableSql('rw', 's', 'p')} AS ok
           FROM bounty_reward rw, bounty_submission s WHERE rw.id = $1 AND s.id = $2`,
        [rewardId, winner.submissionId, [...PAYABLE_REWARD_STATUSES]])).rows[0].ok;
      const withdrawalBlocks = (await db.query<{ n: number }>(PENDING_REWARD_SQL,
        [winner.userId, BountyStatusPolicy.inProgressStatuses(), [...PAYABLE_REWARD_STATUSES]])).rows[0].n > 0;
      const hasOwnRow = (await db.query(`SELECT 1 FROM payout WHERE submission_id = $1`, [winner.submissionId])).rowCount! > 0;
      const status = (await db.query<{ st: string }>(
        `SELECT ${payoutStatusSql('s', 'b')} AS st FROM bounty_submission s JOIN bounty b ON b.id = s.bounty_id WHERE s.id = $1`,
        [winner.submissionId])).rows[0].st;
      const accepted = await rewards.requestPayout(rewardId, winner.submissionId, '1', adminId).then(() => true, () => false);

      expect(predicate).toBe(options.requestable);
      expect(accepted).toBe(predicate);
      expect(withdrawalBlocks).toBe(predicate);
      // 행이 없는 수상자의 지급 상태: 요청 가능하면 PENDING(받을 몫이 있음), 아니면 NONE
      if (!hasOwnRow) expect(status).toBe(predicate ? 'PENDING' : 'NONE');
    });

    // it.each는 행의 원소 수로 콜백 인자를 맞추므로 모든 행이 세 번째 원소(옵션)를 가진다(없으면 done 콜백으로 잡혀 멈춘다)
    it('every scenario row carries its options element', () => {
      expect(scenarios.every((row) => row.length === 3)).toBe(true);
    });
  });
});
