import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { BountyActor } from '../bounties/bounty-actor';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig, unique } from './harness';

/**
 * bounty_application INSERT의 23505를 ALREADY_APPLIED로 바꾸는 조건이 실제 인덱스 이름(0004 `uq_application_user`/`uq_application_agent`)과
 * 맞는지 실 Postgres로 확인한다. 이름이 바뀌면 mock 단위 테스트는 계속 통과하지만 여기서는 깨진다.
 */
describeDb('bounty application unique index names', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let applications: ApplicationsService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(testConfig()));
    applications = new ApplicationsService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await db.onApplicationShutdown();
  });
  afterEach(() => jest.restoreAllMocks());

  async function openBounty(submissionMode: 'DIRECT' | 'AGENT'): Promise<string> {
    const { id } = await bounties.create(adminId, {
      title: unique('uq-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, submissionMode, maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await bounties.transition(id, 'OPEN', adminId);
    return id;
  }

  async function createAgent(ownerId: string): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
       VALUES ($1, 'uq-agent', $2, $3, 'ACTIVE', now()) RETURNING id`,
      [ownerId, unique('pk-'), `0x${unique()}`])).rows[0].id;
  }

  async function duplicateInsertError(bountyId: string, actor: BountyActor): Promise<unknown> {
    return db.query(
      `INSERT INTO bounty_application (bounty_id, applicant_user_id, agent_id, message) VALUES ($1, $2, $3, 'dup')`,
      [bountyId, actor.userId, actor.agentId],
    ).then(() => undefined, (err: unknown) => err);
  }

  /**
   * 같은 주체의 동시 첫 지원을 흉내 낸다: 서비스의 "기존 행" 조회만 빈 결과로 바꿔 INSERT가 실제 유니크 인덱스에 부딪히게 한다.
   * (실제로는 바운티 행 FOR UPDATE가 직렬화하므로 catch는 안전망이다). `replaceInsert`를 주면 지원 INSERT 대신 그 쿼리를 같은 트랜잭션에서 돌린다.
   */
  function hideExistingRow(replaceInsert?: { sql: string; params: unknown[] }) {
    const realTx = db.tx.bind(db);
    jest.spyOn(db, 'tx').mockImplementation(<T>(fn: (client: PoolClient) => Promise<T>) => realTx((client) => {
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      const proxy = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== 'query') return Reflect.get(target, prop, receiver) as unknown;
          return (sql: unknown, params?: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('SELECT id, status FROM bounty_application')) return Promise.resolve({ rowCount: 0, rows: [] });
            if (replaceInsert && typeof sql === 'string' && sql.includes('INSERT INTO bounty_application')) return realQuery(replaceInsert.sql, replaceInsert.params);
            return realQuery(sql, params);
          };
        },
      });
      return fn(proxy);
    }));
  }

  it.each([
    ['user', 'DIRECT', 'uq_application_user'],
    ['agent', 'AGENT', 'uq_application_agent'],
  ] as const)('a duplicate %s application on a %s bounty fails on %s', async (kind, mode, indexName) => {
    const userId = await createUser(db);
    const actor = kind === 'agent' ? BountyActor.agent(await createAgent(userId)) : BountyActor.user(userId);
    const bountyId = await openBounty(mode);
    await (kind === 'agent' ? applications.applyAsAgent(bountyId, actor.id, 'first') : applications.apply(bountyId, userId, 'first'));

    const err = await duplicateInsertError(bountyId, actor);
    expect(err).toMatchObject({ code: '23505', constraint: indexName });
    expect(actor.applicationUniqueIndex).toBe(indexName);
    expect(isUniqueViolation(err, actor.applicationUniqueIndex)).toBe(true);
  });

  it.each(['user', 'agent'] as const)('maps a real %s duplicate INSERT through the service to 409 ALREADY_APPLIED', async (kind) => {
    const userId = await createUser(db);
    const agentId = kind === 'agent' ? await createAgent(userId) : undefined;
    const bountyId = await openBounty(agentId ? 'AGENT' : 'DIRECT');
    const apply = () => agentId ? applications.applyAsAgent(bountyId, agentId, 'apply') : applications.apply(bountyId, userId, 'apply');
    await apply();

    hideExistingRow();
    await expect(apply()).rejects.toMatchObject({ status: 409, message: 'ALREADY_APPLIED' });
  });

  it('rethrows a 23505 from a different unique constraint instead of calling it ALREADY_APPLIED', async () => {
    const userId = await createUser(db);
    const bountyId = await openBounty('DIRECT');

    // 같은 트랜잭션에서 지원과 무관한 유니크 충돌을 일으킨다: 서비스의 INSERT를 다른 유저의 닉네임을 겹치게 하는 UPDATE로 바꾼다
    const { rows: [taken] } = await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [userId]);
    const otherUserId = await createUser(db);
    hideExistingRow({ sql: `UPDATE "user" SET nickname = $1 WHERE id = $2`, params: [taken.nickname, otherUserId] });

    const err = await applications.apply(bountyId, userId, 'again').then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: '23505', constraint: 'uq_user_nickname_active' });
  });
});
