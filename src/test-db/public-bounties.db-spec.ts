import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { BountiesService } from '../bounties/bounties.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig, unique } from './harness';

/** Public bounty reads on a real database - the JSON aggregation a mock DB cannot check. */
describeDb('public bounty list and detail on a real database', () => {
  let db: DatabaseService;
  let adminId: string;
  let admin: BountyAdminService;
  let bounties: BountiesService;
  beforeAll(async () => {
    db = createDb();
    adminId = await createUser(db, { isAdmin: true });
    admin = new BountyAdminService(db, new AuditService(db), new BountyLifecycleService(), new RewardTokenResolver(testConfig()));
    bounties = new BountiesService(db);
  });
  afterAll(async () => db.onApplicationShutdown());

  async function openBounty() {
    const { id } = await admin.create(adminId, {
      title: unique('public-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 2,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await admin.transition(id, 'OPEN', adminId);
    return id;
  }
  const reward = (bountyId: string, amount: string, createdAt: string) => db.query(
    `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address, created_at)
     VALUES ($1, 'NATIVE', 'inj', 'INJ', $2, 'custody', $3)`, [bountyId, amount, createdAt]);

  it('detail lists every reward and attachment, even rewards that look identical, in a stable order', async () => {
    const id = await openBounty();
    await reward(id, '5', '2026-01-01T00:00:03Z');
    await reward(id, '5', '2026-01-01T00:00:02Z'); // same symbol/amount/status as the first: json_agg(DISTINCT) used to merge the pair
    await reward(id, '9', '2026-01-01T00:00:01Z');
    for (const [name, order] of [['b.pdf', 2], ['a.pdf', 1]] as const) {
      await db.query(
        `INSERT INTO bounty_attachment (bounty_id, file_name, file_url, mime_type, file_size, display_order) VALUES ($1, $2, $3, 'application/pdf', 1, $4)`,
        [id, name, `https://x.test/${name}`, order]);
    }

    const detail = await bounties.detail(id) as { rewards: Array<{ amount: string }>; attachments: Array<{ fileName: string }> };
    expect(detail.rewards.map((r) => r.amount)).toEqual(['9', '5', '5']);
    expect(detail.attachments.map((a) => a.fileName)).toEqual(['a.pdf', 'b.pdf']);

    const listed = (await bounties.list(1, 100)).items.find((row) => (row as { id: string }).id === id) as { rewards: Array<{ amount: string }> };
    expect(listed.rewards.map((r) => r.amount)).toEqual(['9', '5', '5']);
  });

  it('a bounty without rewards or attachments returns empty arrays, not null', async () => {
    const detail = await bounties.detail(await openBounty()) as { rewards: unknown[]; attachments: unknown[] };
    expect(detail.rewards).toEqual([]);
    expect(detail.attachments).toEqual([]);
  });
});
