import { ownedAgentIdsSql, participantUserIdSql } from '../agents/owned-agents';
import { DatabaseService } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';
import { primaryWalletSql } from '../wallets/primary-wallet';
import { describeDb } from './describe-db';
import { createDb, createUser, unique } from './harness';

/**
 * 단일 출처 술어 조각(activeUserSql, primaryWalletSql, ownedAgentIdsSql, participantUserIdSql)을 실제 행에 대어 본다.
 * 각 조각은 옮기기 전 호출부의 SQL과 같은 글자로 렌더링되고(sql-predicates.spec.ts), 여기서는 그 조건이 고르는 행을 고정한다:
 * 활성 = ACTIVE + 미삭제(정지·탈퇴 제외), 대표 지갑 = 연결된 is_primary 하나, 소유 에이전트 'live'는 삭제된 에이전트를 빼고
 * 'including-deleted'는 넣는다, 참여자의 사람 = 본인 또는 (삭제됐어도) 에이전트 소유자.
 */
describeDb('SQL predicate fragments on real rows', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onApplicationShutdown());

  async function addAgent(owner: string, deleted: boolean): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, deleted_at)
       VALUES ($1, 'a', $2, $3, CASE WHEN $4::boolean THEN 'PENDING_VERIFICATION' ELSE 'ACTIVE' END, CASE WHEN $4::boolean THEN now() END)
       RETURNING id`,
      [owner, `pk-${unique()}`, `inj1${unique()}`, deleted],
    );
    return r.rows[0].id;
  }

  it('activeUserSql keeps ACTIVE users and drops SUSPENDED and withdrawn ones (aliased and bare forms agree)', async () => {
    const active = await createUser(db);
    const suspended = await createUser(db);
    const withdrawn = await createUser(db);
    await db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);
    await db.query(`UPDATE "user" SET status = 'WITHDRAWN', deleted_at = now() WHERE id = $1`, [withdrawn]);
    const ids = [active, suspended, withdrawn];
    const aliased = await db.query<{ id: string }>(`SELECT u.id FROM "user" u WHERE u.id = ANY($1::uuid[]) AND ${activeUserSql('u')}`, [ids]);
    const bare = await db.query<{ id: string }>(`SELECT id FROM "user" WHERE id = ANY($1::uuid[]) AND ${activeUserSql('')}`, [ids]);
    expect(aliased.rows.map((r) => r.id)).toEqual([active]);
    expect(bare.rows.map((r) => r.id)).toEqual([active]);
  });

  it('primaryWalletSql picks the connected primary wallet only', async () => {
    const user = await createUser(db);
    const insert = (primary: boolean, disconnected: boolean) => db.query<{ id: string }>(
      `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at, disconnected_at)
       VALUES ($1, 'INJECTIVE', $2, $3, now(), CASE WHEN $4::boolean THEN now() END) RETURNING id`,
      [user, `inj1${unique()}`, primary, disconnected],
    ).then((r) => r.rows[0].id);
    await insert(true, true); // 연결 해제된 옛 대표 지갑
    await insert(false, false); // 대표가 아닌 지갑
    const current = await insert(true, false);
    const r = await db.query<{ id: string }>(`SELECT w.id FROM wallet w WHERE w.user_id = $1 AND ${primaryWalletSql('w')}`, [user]);
    expect(r.rows.map((row) => row.id)).toEqual([current]);
  });

  it("ownedAgentIdsSql: 'live' excludes soft-deleted agents, 'including-deleted' keeps them, other owners never match", async () => {
    const owner = await createUser(db);
    const other = await createUser(db);
    const live = await addAgent(owner, false);
    const deleted = await addAgent(owner, true);
    await addAgent(other, false);
    const pick = async (scope: 'live' | 'including-deleted') =>
      (await db.query<{ ids: string[] }>(`SELECT ${ownedAgentIdsSql('$1', scope)}::text[] AS ids`, [owner])).rows[0].ids.sort();
    expect(await pick('live')).toEqual([live]);
    expect(await pick('including-deleted')).toEqual([live, deleted].sort());
  });

  it('participantUserIdSql resolves a user row to itself and an agent row to its owner, even when the agent was soft-deleted', async () => {
    const human = await createUser(db);
    const owner = await createUser(db);
    const deletedAgent = await addAgent(owner, true);
    const r = await db.query<{ who: string }>(
      `SELECT ${participantUserIdSql('x', 'submitter_user_id', 'ax')} AS who
         FROM (VALUES ($1::uuid, NULL::uuid, 1), (NULL::uuid, $2::uuid, 2)) AS x(submitter_user_id, agent_id, n)
        ORDER BY x.n`,
      [human, deletedAgent],
    );
    expect(r.rows.map((row) => row.who)).toEqual([human, owner]);
  });
});
