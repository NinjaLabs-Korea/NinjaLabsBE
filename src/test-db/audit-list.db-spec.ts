import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser, unique } from './harness';

describeDb('audit log listing on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  beforeAll(() => { db = createDb(); audit = new AuditService(db); });
  afterAll(async () => db.onApplicationShutdown());

  it('names the actor (nickname) and returns before/after data, so a payout row shows who requested/approved and the amounts', async () => {
    const requester = await createUser(db, { isAdmin: true, nickname: unique('req_') });
    const approver = await createUser(db, { isAdmin: true, nickname: unique('app_') });
    const entityId = '33333333-3333-4333-8333-333333333333';
    await db.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'PAYOUT_REQUESTED', 'payout', $3, NULL, '{"amount":"100","txHash":null}'::jsonb),
              ($2, 'PAYOUT_APPROVED', 'payout', $3, '{"status":"REQUESTED"}'::jsonb, '{"status":"APPROVED"}'::jsonb),
              (NULL, 'ADMIN_GRANTED', 'payout', $3, NULL, NULL)`,
      [requester, approver, entityId],
    );
    const { items, total } = await audit.list({ page: 1, entityType: 'payout', entityId });
    expect(total).toBe(3);
    const byAction = Object.fromEntries(items.map((row) => [row.action, row]));
    expect(byAction.PAYOUT_REQUESTED).toMatchObject({ actor_user_id: requester, after_data: { amount: '100', txHash: null } });
    expect(byAction.PAYOUT_REQUESTED.actor_nickname).toMatch(/^req_/);
    expect(byAction.PAYOUT_APPROVED).toMatchObject({ before_data: { status: 'REQUESTED' }, after_data: { status: 'APPROVED' } });
    expect(byAction.PAYOUT_APPROVED.actor_nickname).toMatch(/^app_/);
    // script rows have no actor: the nickname is null, the row is still listed
    expect(byAction.ADMIN_GRANTED).toMatchObject({ actor_user_id: null, actor_nickname: null, actor_agent_name: null });
  });
});
