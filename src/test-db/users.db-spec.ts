import { DatabaseService } from '../common/database/database.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
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
  afterAll(async () => db.onApplicationShutdown());

  async function bounty(createdBy: string, title: string, options: { deleted?: boolean } = {}): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, deleted_at)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', CASE WHEN $3::boolean THEN now() END) RETURNING id`,
      [createdBy, title, options.deleted ?? false])).rows[0].id;
  }
  /** 기본은 입금 확인된(FUNDED, deposited = amount) 보상 — payoutStatus는 입금 확인된 보상만 센다 */
  async function reward(bountyId: string, amount: number, symbol = 'INJ', options: { status?: string; deposited?: number } = {}): Promise<string> {
    const status = options.status ?? 'FUNDED';
    const deposited = options.deposited ?? (status === 'DEPOSIT_PENDING' ? 0 : amount);
    return (await db.query<{ id: string }>(
      `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address, status, deposited_amount, deposited_at)
       VALUES ($1, 'NATIVE', 'inj', $2, $3, 'inj1custody', $4, $5::numeric, CASE WHEN $5::numeric = 0 THEN NULL ELSE now() END) RETURNING id`,
      [bountyId, symbol, amount, status, deposited])).rows[0].id;
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

  it('publicProfile payoutStatus: NONE / PENDING / PAID / PARTIALLY_PAID-while-another-payout-is-unpaid, rewards list only PAID amounts', async () => {
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
    expect(byTitle.mixed.payoutStatus).toBe('PARTIALLY_PAID'); // the FAILED payout's reward is still owed to this submission
    expect(byTitle.mixed.rewards).toEqual([{ amount: '7', symbol: 'INJ' }]);
    expect(byTitle.mixed.postedRewards).toEqual([{ amount: '7', symbol: 'INJ' }, { amount: '9', symbol: 'USDT' }]);
  });

  describe('payout status (rewards/payout-status.ts) — same value on GET /users/:nickname and GET /submissions/me', () => {
    it('PAID / PARTIALLY_PAID / PAID-when-the-rest-went-to-others / PENDING / NONE, counting only the rewards owed to this submission', async () => {
      const admin = await createUser(db, { isAdmin: true });
      const nickname = `Pst${unique().slice(0, 8)}`;
      const builder = await createUser(db, { nickname });
      const wallet = await createPrimaryWallet(db, builder);
      const other = await createUser(db);
      const otherWallet = await createPrimaryWallet(db, other);
      let hour = 10;
      const approved = async (bountyId: string, userId = builder) => submission(bountyId, { userId }, 'APPROVED', `now() - interval '${hour--} hours'`);

      // 1. single reward, paid to this submission
      const single = await bounty(admin, 'single-paid');
      const singleReward = await reward(single, 100, 'INJ', { status: 'PAID' });
      await payout(singleReward, await approved(single), wallet.id, admin, 100, 'PAID');

      // 2. two rewards: one paid to this submission, the other still has headroom → this submission can still be paid
      const partial = await bounty(admin, 'partial');
      const pA = await reward(partial, 10);
      await reward(partial, 20, 'USDT');
      await payout(pA, await approved(partial), wallet.id, admin, 10, 'PAID');

      // 3. two rewards: one paid to this submission, the other exhausted by another winner (cap = LEAST(amount 30, deposited 20))
      const exhausted = await bounty(admin, 'exhausted');
      const [eA, eB] = [await reward(exhausted, 10), await reward(exhausted, 30, 'USDT', { status: 'PAID', deposited: 20 })];
      await payout(eA, await approved(exhausted), wallet.id, admin, 10, 'PAID');
      await payout(eB, await approved(exhausted, other), otherWallet.id, admin, 20, 'PAID');

      // 3b. same, but the other winner's payout was CANCELLED → headroom is back, so this submission is only partially paid
      const reopened = await bounty(admin, 'reopened');
      const [rA, rB] = [await reward(reopened, 10), await reward(reopened, 20, 'USDT')];
      await payout(rA, await approved(reopened), wallet.id, admin, 10, 'PAID');
      await payout(rB, await approved(reopened, other), otherWallet.id, admin, 20, 'CANCELLED');

      // 4. funded reward, nothing paid yet (one payout still in flight on a second reward)
      const pending = await bounty(admin, 'pending');
      const [nA, nB] = [await reward(pending, 10), await reward(pending, 20, 'USDT')];
      await payout(nB, await approved(pending), wallet.id, admin, 20, 'BROADCASTING');
      expect(nA).toEqual(expect.any(String)); // owed through headroom alone

      // 5. rewards exist but none is funded (DEPOSIT_PENDING / REFUNDED / CANCELLED) → NONE
      const unfunded = await bounty(admin, 'unfunded');
      await reward(unfunded, 10, 'INJ', { status: 'DEPOSIT_PENDING' });
      await reward(unfunded, 10, 'USDT', { status: 'REFUNDED' });
      await reward(unfunded, 10, 'USDC', { status: 'CANCELLED', deposited: 0 });
      await approved(unfunded);

      // 5b. funded, but the whole cap went to another winner before this submission got anything → NONE
      const gone = await bounty(admin, 'gone');
      const goneReward = await reward(gone, 50, 'INJ', { status: 'PAID' });
      await approved(gone);
      await payout(goneReward, await approved(gone, other), otherWallet.id, admin, 50, 'PAID');

      const expected = {
        'single-paid': 'PAID', partial: 'PARTIALLY_PAID', exhausted: 'PAID', reopened: 'PARTIALLY_PAID', pending: 'PENDING', unfunded: 'NONE', gone: 'NONE',
      };
      const profile = await users.publicProfile(nickname);
      const rows = profile.completedBounties as Array<{ title: string; payoutStatus: string; rewards: unknown[]; postedRewards: unknown[] }>;
      expect(Object.fromEntries(rows.map((row) => [row.title, row.payoutStatus]))).toEqual(expected);
      // rewards / postedRewards keep their meaning (PAID payouts of this submission / everything posted)
      const byTitle = Object.fromEntries(rows.map((row) => [row.title, row]));
      expect(byTitle.partial.rewards).toEqual([{ amount: '10', symbol: 'INJ' }]);
      expect(byTitle.partial.postedRewards).toEqual([{ amount: '10', symbol: 'INJ' }, { amount: '20', symbol: 'USDT' }]);
      expect(byTitle.gone.rewards).toEqual([]);

      const mine = await new SubmissionsService(db).mySubmissions(builder);
      expect(Object.fromEntries((mine as Array<{ bounty_title: string; payment_status: string }>).map((row) => [row.bounty_title, row.payment_status])))
        .toEqual(expected);
    });
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
