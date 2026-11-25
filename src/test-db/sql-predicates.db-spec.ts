import { DatabaseService } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';
import { describeDb } from './describe-db';
import { createDb, createUser } from './harness';

/**
 * 단일 출처 술어 조각(activeUserSql)을 실제 행에 대어 본다(ownedAgentIdsSql/participantUserIdSql은 에이전트 제거와 함께 지웠다, BE PR4).
 * 조각은 옮기기 전 호출부의 SQL과 같은 글자로 렌더링되고(sql-predicates.spec.ts), 여기서는 그 조건이 고르는 행을 고정한다:
 * 활성 = ACTIVE + 미삭제(정지·탈퇴 제외).
 */
describeDb('SQL predicate fragments on real rows', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onApplicationShutdown());

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
});
