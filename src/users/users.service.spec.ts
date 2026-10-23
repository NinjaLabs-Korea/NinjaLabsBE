import { DatabaseService } from '../common/database/database.service';
import { UsersService } from './users.service';

describe('UsersService publicProfile', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function setup() {
    const db = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM "user" u')) return { rowCount: 1, rows: [{ id: userId, nickname: 'ryan', tags: [] }] };
        return { rowCount: 0, rows: [] };
      }),
    };
    return { db, service: new UsersService(db as unknown as DatabaseService) };
  }

  it('lists only what the user (or their agents) actually received: PAID payouts, excluding deleted bounties', async () => {
    const { db, service } = setup();
    const profile = await service.publicProfile('ryan');
    expect(profile).toMatchObject({ id: userId, completedBounties: [], agents: [], nfts: [] });

    const completed = db.query.mock.calls.find(([sql]) => (sql as string).includes('AS completed_at'))!;
    const sql = completed[0] as string;
    expect(completed[1]).toEqual([userId]);
    // element shape unchanged: { amount: '<integer string>', symbol }
    expect(sql).toContain("'amount', p.amount::text");
    expect(sql).toContain("'symbol', r.display_symbol");
    expect(sql).toContain("LEFT JOIN payout p ON p.submission_id = s.id AND p.status = 'PAID'");
    expect(sql).toContain('LEFT JOIN bounty_reward r ON r.id = p.bounty_reward_id');
    expect(sql).toContain('FILTER (WHERE p.id IS NOT NULL)');
    expect(sql).not.toContain('LEFT JOIN bounty_reward r ON r.bounty_id = b.id');
    expect(sql).toContain("s.status = 'APPROVED' AND b.deleted_at IS NULL");
    expect(sql).toContain('(s.submitter_user_id = $1 OR ag.owner_user_id = $1)');
    expect(sql).toContain('LEFT JOIN agent ag ON ag.id = s.agent_id AND ag.deleted_at IS NULL');
  });

  it('also reports what the bounty posted and whether this submission has been paid (postedRewards + payoutStatus)', async () => {
    const { db, service } = setup();
    await service.publicProfile('ryan');
    const sql = db.query.mock.calls.find(([text]) => (text as string).includes('AS completed_at'))![0] as string;
    // same element shape as rewards, but from bounty_reward (what was posted) rather than payout (what was paid)
    expect(sql).toContain(`json_build_object('amount', rw.amount::text, 'symbol', rw.display_symbol) ORDER BY rw.created_at)
                          FROM bounty_reward rw WHERE rw.bounty_id = b.id), '[]') AS "postedRewards"`);
    // NONE (no reward posted) / PAID (only PAID payouts for this submission) / PENDING (everything else) — same rule as /submissions/me
    expect(sql).toContain(`CASE WHEN NOT EXISTS (SELECT 1 FROM bounty_reward rw WHERE rw.bounty_id = b.id) THEN 'NONE'`);
    expect(sql).toContain(`WHERE px.submission_id = s.id AND rw.bounty_id = b.id AND px.status = 'PAID')`);
    expect(sql).toContain(`WHERE px.submission_id = s.id AND rw.bounty_id = b.id AND px.status <> 'PAID') THEN 'PAID'`);
    expect(sql).toContain(`ELSE 'PENDING' END AS "payoutStatus"`);
    // existing fields stay
    expect(sql).toContain('SELECT b.id, b.title, b.category, s.reviewed_at AS completed_at');
  });

  it('returns 404 for unknown or inactive users', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    await expect(new UsersService(db as unknown as DatabaseService).publicProfile('ghost'))
      .rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
  });
});
