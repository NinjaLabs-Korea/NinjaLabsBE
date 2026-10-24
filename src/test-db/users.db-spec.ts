import { DatabaseService } from '../common/database/database.service';
import { UsersService } from '../users/users.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, unique } from './harness';

// users.service → nickname.ts only; no ESM imports on this path.

describeDb('users on a real database', () => {
  let db: DatabaseService;
  let users: UsersService;

  beforeAll(() => {
    db = createDb();
    users = new UsersService(db);
  });
  afterAll(async () => db.onModuleDestroy());

  async function bounty(createdBy: string, title: string, options: { deleted?: boolean } = {}): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, deleted_at)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', CASE WHEN $3::boolean THEN now() END) RETURNING id`,
      [createdBy, title, options.deleted ?? false])).rows[0].id;
  }
  async function reward(bountyId: string, amount: number, symbol = 'INJ'): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address)
       VALUES ($1, 'NATIVE', 'inj', $2, $3, 'inj1custody') RETURNING id`, [bountyId, symbol, amount])).rows[0].id;
  }
  async function submission(bountyId: string, actor: { userId?: string; agentId?: string }, status = 'APPROVED', reviewedAt = 'now()'): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, agent_id, submission_url, description, status, reviewed_at)
       VALUES ($1, $2, $3, 'https://example.test/w', 'd', $4, ${reviewedAt}) RETURNING id`,
      [bountyId, actor.userId ?? null, actor.agentId ?? null, status])).rows[0].id;
  }
  async function payout(rewardId: string, submissionId: string, walletId: string, requestedBy: string, amount: number, status: string) {
    await db.query(
      `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, paid_at)
       VALUES ($1, $2, $3, $4, $5::varchar, $6, $7, CASE WHEN $5::varchar = 'PAID' THEN now() END)`,
      [rewardId, submissionId, walletId, amount, status, unique('idem-'), requestedBy]);
  }

  it('publicProfile payoutStatus: NONE / PENDING / PAID / PENDING-while-any-payout-is-unpaid, rewards list only PAID amounts', async () => {
    const admin = await createUser(db, { isAdmin: true });
    const nickname = `Pay${unique().slice(0, 8)}`;
    const builder = await createUser(db, { nickname });
    const wallet = await createPrimaryWallet(db, builder);

    const none = await bounty(admin, 'none');
    await submission(none, { userId: builder }, 'APPROVED', "now() - interval '4 hours'");

    const pending = await bounty(admin, 'pending');
    const pendingReward = await reward(pending, 500);
    await payout(pendingReward, await submission(pending, { userId: builder }, 'APPROVED', "now() - interval '3 hours'"), wallet.id, admin, 500, 'AWAITING_MULTISIG_APPROVAL');

    const paid = await bounty(admin, 'paid');
    const paidReward = await reward(paid, 1000, 'USDT');
    await payout(paidReward, await submission(paid, { userId: builder }, 'APPROVED', "now() - interval '2 hours'"), wallet.id, admin, 1000, 'PAID');

    const mixed = await bounty(admin, 'mixed');
    const [inj, usdt] = [await reward(mixed, 7), await reward(mixed, 9, 'USDT')];
    const mixedSub = await submission(mixed, { userId: builder }, 'APPROVED', "now() - interval '1 hour'");
    await payout(inj, mixedSub, wallet.id, admin, 7, 'PAID');
    await payout(usdt, mixedSub, wallet.id, admin, 9, 'FAILED');

    const profile = await users.publicProfile(nickname.toLowerCase());
    expect((profile as Record<string, unknown>).nickname).toBe(nickname);
    const rows = profile.completedBounties as Array<{ id: string; title: string; payoutStatus: string; rewards: unknown[]; postedRewards: unknown[] }>;
    // newest review first
    expect(rows.map((row) => row.title)).toEqual(['mixed', 'paid', 'pending', 'none']);
    const byTitle = Object.fromEntries(rows.map((row) => [row.title, row]));
    expect(byTitle.none).toMatchObject({ id: none, payoutStatus: 'NONE', rewards: [], postedRewards: [] });
    expect(byTitle.pending).toMatchObject({ payoutStatus: 'PENDING', rewards: [], postedRewards: [{ amount: '500', symbol: 'INJ' }] });
    expect(byTitle.paid).toMatchObject({ payoutStatus: 'PAID', rewards: [{ amount: '1000', symbol: 'USDT' }], postedRewards: [{ amount: '1000', symbol: 'USDT' }] });
    expect(byTitle.mixed.payoutStatus).toBe('PENDING');
    expect(byTitle.mixed.rewards).toEqual([{ amount: '7', symbol: 'INJ' }]);
    expect(byTitle.mixed.postedRewards).toEqual([{ amount: '7', symbol: 'INJ' }, { amount: '9', symbol: 'USDT' }]);
  });

  it('publicProfile completed bounties include approved work of owned agents, exclude other statuses, deleted bounties and deleted agents', async () => {
    const admin = await createUser(db, { isAdmin: true });
    const nickname = `Agt${unique().slice(0, 8)}`;
    const owner = await createUser(db, { nickname });
    const agent = async (deleted: boolean) => (await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, deleted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', CASE WHEN $5::boolean THEN now() END) RETURNING id`,
      [owner, unique('bot-'), unique('pk-'), `inj1${unique()}`, deleted])).rows[0].id;
    const [liveAgent, deletedAgent] = [await agent(false), await agent(true)];

    await submission(await bounty(admin, 'by-agent'), { agentId: liveAgent });
    await submission(await bounty(admin, 'by-deleted-agent'), { agentId: deletedAgent });
    await submission(await bounty(admin, 'rejected'), { userId: owner }, 'REJECTED');
    await submission(await bounty(admin, 'in-review'), { userId: owner }, 'IN_REVIEW');
    await submission(await bounty(admin, 'deleted-bounty', { deleted: true }), { userId: owner });
    await submission(await bounty(admin, 'mine'), { userId: owner });
    await submission(await bounty(admin, 'someone-else'), { userId: admin });

    const profile = await users.publicProfile(nickname);
    expect((profile.completedBounties as Array<{ title: string }>).map((row) => row.title).sort()).toEqual(['by-agent', 'mine']);
    const agents = profile.agents as Array<{ id: string; completed_bounties: Array<{ title: string }> }>;
    expect(agents.map((a) => a.id)).toEqual([liveAgent]);
    expect(agents[0].completed_bounties.map((b) => b.title)).toEqual(['by-agent']);
  });

  it('nickname availability and save use the active-user unique index: a deleted user frees the name, a live one is NICKNAME_TAKEN', async () => {
    const name = `Uq${unique().slice(0, 8)}`;
    const holder = await createUser(db, { nickname: name });
    const other = await createUser(db);
    await expect(users.nicknameAvailable(name.toUpperCase())).resolves.toBe(false);
    await expect(users.completeProfile(other, name.toLowerCase(), 'bio', ['DEV'])).rejects.toMatchObject({ status: 409, message: 'NICKNAME_TAKEN' });
    // the failed save rolled back entirely: no tag rows, step unchanged
    const tags = await db.query(`SELECT 1 FROM user_tag WHERE user_id = $1`, [other]);
    expect(tags.rowCount).toBe(0);

    await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [holder]);
    await expect(users.nicknameAvailable(name)).resolves.toBe(true);
    await expect(users.completeProfile(other, name, 'bio', ['DEV', 'CONTENT'])).resolves.toEqual({ ok: true });
    const saved = await db.query<{ nickname: string; onboarding_step: number }>(`SELECT nickname, onboarding_step FROM "user" WHERE id = $1`, [other]);
    expect(saved.rows[0]).toEqual({ nickname: name, onboarding_step: 4 });

    // an edit replaces the tag set (removed tags are gone)
    await users.completeProfile(other, name, 'bio 2', ['OTHER']);
    const after = await db.query<{ tag: string }>(`SELECT tag FROM user_tag WHERE user_id = $1`, [other]);
    expect(after.rows.map((row) => row.tag)).toEqual(['OTHER']);
  });

  it('completeOnboarding stamps once and keeps the first completion time on repeat', async () => {
    const userId = await createUser(db);
    await users.completeOnboarding(userId);
    const first = (await db.query<{ at: Date }>(`SELECT onboarding_completed_at AS at FROM "user" WHERE id = $1`, [userId])).rows[0].at;
    expect(first).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(users.completeOnboarding(userId)).resolves.toEqual({ ok: true });
    const second = (await db.query<{ at: Date }>(`SELECT onboarding_completed_at AS at FROM "user" WHERE id = $1`, [userId])).rows[0].at;
    expect(second.getTime()).toBe(first.getTime());
  });
});
