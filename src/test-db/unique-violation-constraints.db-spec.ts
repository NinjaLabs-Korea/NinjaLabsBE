import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { GOOGLE_USER_UNIQUE_INDEXES, AuthService } from '../auth/auth.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { DEPOSIT_TX_UNIQUE_INDEX, RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { createDb, createUser, fakeTxHash, TEST_JWT_SECRET, testConfig, unique, withPayoutAddresses } from './harness';

/**
 * 서비스가 23505를 도메인 코드로 바꿀 때 보는 제약 이름(auth/rewards의 상수)이 실제 마이그레이션의 인덱스 이름과 맞는지
 * 실 Postgres로 확인한다. 이름이 바뀌면 mock 단위 테스트는 계속 통과하지만 여기서는 깨진다.
 */
describeDb('unique violation constraint names used by the services', () => {
  let db: DatabaseService;
  let auth: AuthService;
  let rewards: RewardsService;
  let bounties: BountyAdminService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const config = testConfig();
    const audit = new AuditService(db);
    auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }), config, TEST_JWT_SECRET);
    rewards = withPayoutAddresses(db, new RewardsService(db, audit, config));
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  /** 쿼리가 실패하면 그 오류, 성공하면 undefined */
  const failureOf = (sql: string, params: unknown[]) => db.query(sql, params).then(() => undefined, (err: unknown) => err);

  describe('auth: first Google login', () => {
    const insertUser = (googleId: string, email: string) => failureOf(
      `INSERT INTO "user" (google_id, email, nickname, bio) VALUES ($1, $2, $3, '')`, [googleId, email, `u_${unique()}`]);

    it('a duplicate active google_id fails on uq_user_google_id and a duplicate active email on uq_user_email', async () => {
      const googleId = unique('google-');
      const email = `${unique()}@example.test`;
      await auth.upsertGoogleUser(googleId, email);

      const byGoogle = await insertUser(googleId, `${unique()}@example.test`);
      expect(byGoogle).toMatchObject({ code: '23505', constraint: 'uq_user_google_id' });
      const byEmail = await insertUser(unique('google-'), email);
      expect(byEmail).toMatchObject({ code: '23505', constraint: 'uq_user_email' });
      expect([...GOOGLE_USER_UNIQUE_INDEXES].sort()).toEqual(['uq_user_email', 'uq_user_google_id']);
      expect(isUniqueViolation(byGoogle, GOOGLE_USER_UNIQUE_INDEXES)).toBe(true);
      expect(isUniqueViolation(byEmail, GOOGLE_USER_UNIQUE_INDEXES)).toBe(true);
    });

    it('a new Google account with the email of another active account is 409 ACCOUNT_CONFLICT through the service', async () => {
      const email = `${unique()}@example.test`;
      await auth.upsertGoogleUser(unique('google-'), email);
      await expect(auth.upsertGoogleUser(unique('google-'), email)).rejects.toMatchObject({ status: 409, message: 'ACCOUNT_CONFLICT' });
    });

    it('the temporary nickname index is a different constraint, so it is not treated as an account conflict', async () => {
      const taken = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [adminId])).rows[0].nickname;
      const err = await failureOf(`INSERT INTO "user" (google_id, email, nickname, bio) VALUES ($1, $2, $3, '')`,
        [unique('google-'), `${unique()}@example.test`, taken]);
      expect(err).toMatchObject({ code: '23505', constraint: 'uq_user_nickname_active' });
      expect(isUniqueViolation(err, GOOGLE_USER_UNIQUE_INDEXES)).toBe(false);
    });
  });

  describe('rewards: deposit tx hash', () => {
    async function pendingReward(): Promise<string> {
      const { id } = await bounties.create(adminId, {
        title: unique('uqv-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 1,
        submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '10' },
      });
      return (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [id])).rows[0].id;
    }

    it(`a reused deposit hash fails on ${DEPOSIT_TX_UNIQUE_INDEX}`, async () => {
      const [first, second] = [await pendingReward(), await pendingReward()];
      const hash = fakeTxHash().toLowerCase();
      await db.query(`UPDATE bounty_reward SET deposit_tx_hash = $2 WHERE id = $1`, [first, hash]);
      const err = await failureOf(`UPDATE bounty_reward SET deposit_tx_hash = $2 WHERE id = $1`, [second, hash]);
      expect(err).toMatchObject({ code: '23505', constraint: 'uq_bounty_reward_deposit_tx' });
      expect(isUniqueViolation(err, DEPOSIT_TX_UNIQUE_INDEX)).toBe(true);
    });

    it('confirming the same hash on a second reward is 409 TX_HASH_ALREADY_USED and the reward stays DEPOSIT_PENDING', async () => {
      const [first, second] = [await pendingReward(), await pendingReward()];
      const hash = fakeTxHash();
      await rewards.confirmDeposit(first, hash, '10', adminId);
      await expect(rewards.confirmDeposit(second, hash, '10', adminId)).rejects.toMatchObject({ status: 409, message: 'TX_HASH_ALREADY_USED' });
      const status = await db.query<{ status: string; deposit_tx_hash: string | null }>(`SELECT status, deposit_tx_hash FROM bounty_reward WHERE id = $1`, [second]);
      expect(status.rows[0]).toEqual({ status: 'DEPOSIT_PENDING', deposit_tx_hash: null });
    });
  });
});
