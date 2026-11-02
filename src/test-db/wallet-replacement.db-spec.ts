import { JwtService } from '@nestjs/jwt';
import { HDNodeWallet, Wallet } from 'ethers';
import { AuditService } from '../audit/audit.service';
import { AgentsService } from '../agents/agents.service';
import { AuthService } from '../auth/auth.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { MaintenanceService } from '../common/maintenance/maintenance.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { WalletReplacementService } from '../wallets/wallet-replacement.service';
import { WalletsService } from '../wallets/wallets.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser, deferred, fakeTxHash, TEST_JWT_SECRET, testConfig, unique, waitForLockWaiter } from './harness';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('primary receiving wallet replacement', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let service: WalletReplacementService;
  let rewards: RewardsService;
  let bounties: BountyAdminService;
  let submissions: SubmissionsService;
  let withdrawal: AccountWithdrawalService;
  let admin: string;
  beforeAll(async () => {
    db = createDb();
    const config = testConfig({ WALLET_REPLACEMENT_ENABLED: 'true' });
    audit = new AuditService(db);
    service = new WalletReplacementService(db, audit, config);
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    submissions = new SubmissionsService(db, audit);
    const auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET }), config, TEST_JWT_SECRET);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
    admin = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  async function fixture() {
    const nickname = unique('switch_');
    const userId = await createUser(db, { nickname });
    const old = Wallet.createRandom();
    const next = Wallet.createRandom();
    const wallet = (await db.query<{ id: string }>(
      `INSERT INTO wallet (user_id, address, verified_at) VALUES ($1, $2, now()) RETURNING id`,
      [userId, getInjectiveAddress(old.address)])).rows[0];
    return { userId, nickname, old, next, walletId: wallet.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function prepare(f: Fixture, next: HDNodeWallet = f.next) {
    const challenge = await service.createChallenge(f.userId, f.old.address, next.address);
    const proof = { challengeId: challenge.id, currentSignature: await f.old.signMessage(challenge.currentMessage), newSignature: await next.signMessage(challenge.newMessage) };
    return { challenge, proof };
  }
  const primary = async (userId: string) => (await db.query(
    `SELECT id, address FROM wallet WHERE user_id = $1 AND disconnected_at IS NULL AND is_primary`, [userId])).rows;
  const unchanged = async (f: Fixture) => expect(await primary(f.userId)).toEqual([{ id: f.walletId, address: getInjectiveAddress(f.old.address) }]);

  async function payable(f: Fixture, agent = false) {
    const { id: bountyId } = await bounties.create(admin, {
      title: unique('b-'), sponsorName: 's', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode: agent ? 'AGENT' : 'DIRECT', maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 86_400_000).toISOString(),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1000' },
    });
    const rewardId = (await db.query(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id as string;
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', admin);
    await bounties.transition(bountyId, 'OPEN', admin);
    let submission;
    const input = { submissionUrl: 'https://example.test/work', description: 'd' };
    if (agent) {
      const agentId = (await db.query(`INSERT INTO agent (owner_user_id, name, wallet_address, status) VALUES ($1, 'bot', $2, 'ACTIVE') RETURNING id`,
        [f.userId, Wallet.createRandom().address])).rows[0].id;
      submission = await submissions.submitAsAgent(bountyId, agentId, input);
    } else submission = await submissions.submit(bountyId, f.userId, input);
    await db.query(`UPDATE bounty_submission SET status = 'APPROVED' WHERE id = $1`, [submission.id]);
    return { rewardId, submissionId: submission.id, bountyId };
  }

  it('preserves historical wallet/NFT/payout rows, switches atomically, and creates neither a parent NFT nor a second audit on retries', async () => {
    const f = await fixture();
    const nft = (await db.query(`INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address, status, token_id)
      VALUES ($1, $2, 'NINJA_PARENT', 'contract', 'MINTED', 'existing') RETURNING id`, [f.userId, f.walletId])).rows[0];
    const p = await payable(f);
    const paid = await rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    await db.query(`UPDATE payout SET status = 'PAID', payout_tx_hash = $2 WHERE id = $1`, [paid.id, fakeTxHash()]);
    const { challenge, proof } = await prepare(f);
    expect(challenge.currentMessage).toContain(f.walletId);
    expect(challenge.currentMessage).toContain(getInjectiveAddress(f.next.address));
    expect(challenge.currentMessage).not.toBe(challenge.newMessage);
    const result = await service.verify(f.userId, proof);
    expect(result.address).toBe(getInjectiveAddress(f.next.address));
    expect(await service.verify(f.userId, proof)).toEqual(result);
    expect((await db.query(`SELECT address, is_primary, disconnected_at FROM wallet WHERE id = $1`, [f.walletId])).rows[0])
      .toEqual({ address: getInjectiveAddress(f.old.address), is_primary: false, disconnected_at: expect.any(Date) });
    expect((await db.query(`SELECT id, owner_wallet_id FROM nft WHERE owner_user_id = $1`, [f.userId])).rows)
      .toEqual([{ id: nft.id, owner_wallet_id: f.walletId }]);
    expect((await db.query(`SELECT recipient_wallet_id FROM payout WHERE id = $1`, [paid.id])).rows[0].recipient_wallet_id).toBe(f.walletId);
    expect(await auditActions(db, 'user', f.userId)).toEqual(['WALLET_REPLACED']);
  });

  it.each(['old', 'new', 'role-replay'])('rejects forged %s proof without consuming the request or disconnecting the old wallet', async (kind) => {
    const f = await fixture();
    const { challenge, proof } = await prepare(f);
    if (kind === 'old') proof.currentSignature = await f.next.signMessage(challenge.currentMessage);
    if (kind === 'new') proof.newSignature = await f.old.signMessage(challenge.newMessage);
    if (kind === 'role-replay') proof.newSignature = proof.currentSignature;
    await expect(service.verify(f.userId, proof)).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
    await unchanged(f);
    expect((await db.query(`SELECT completed_at FROM wallet_replacement_challenge WHERE id = $1`, [challenge.id])).rows[0].completed_at).toBeNull();
  });

  it('rejects same-account aliases, bad addresses, wrong current wallets and accounts without a wallet', async () => {
    const f = await fixture();
    await expect(service.createChallenge(f.userId, f.old.address, getInjectiveAddress(f.old.address))).rejects.toMatchObject({ message: 'WALLET_CHANGE_SAME_ADDRESS' });
    await expect(service.createChallenge(f.userId, f.next.address, Wallet.createRandom().address)).rejects.toMatchObject({ message: 'WALLET_CHANGE_STALE' });
    await expect(service.createChallenge(f.userId, f.old.address, '0x1234')).rejects.toMatchObject({ message: 'INVALID_INJECTIVE_ADDRESS' });
    await expect(service.createChallenge(await createUser(db), f.old.address, f.next.address)).rejects.toMatchObject({ message: 'WALLET_CHANGE_REQUIRES_WALLET' });
    await unchanged(f);
  });

  it('rejects expired, foreign and superseded authorizations', async () => {
    const f = await fixture();
    const a = await prepare(f);
    await expect(service.verify(await createUser(db), a.proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_NOT_FOUND' });
    const b = await prepare(f);
    await expect(service.verify(f.userId, a.proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_NOT_FOUND' });
    await db.query(`UPDATE wallet_replacement_challenge SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [b.challenge.id]);
    await expect(service.verify(f.userId, b.proof)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    await unchanged(f);
  });

  it('double verification is idempotent, and an older completed request cannot switch a later wallet back', async () => {
    const f = await fixture();
    const a = await prepare(f);
    const [first, retry] = await Promise.all([service.verify(f.userId, a.proof), service.verify(f.userId, a.proof)]);
    expect(first).toEqual(retry);
    const next = Wallet.createRandom();
    const b = await service.createChallenge(f.userId, f.next.address, next.address);
    await service.verify(f.userId, { challengeId: b.id, currentSignature: await f.next.signMessage(b.currentMessage), newSignature: await next.signMessage(b.newMessage) });
    await expect(service.verify(f.userId, a.proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_STALE' });
    expect((await primary(f.userId))[0].address).toBe(getInjectiveAddress(next.address));
    expect(await auditActions(db, 'user', f.userId)).toHaveLength(2);
  });

  it('rolls back when two users concurrently claim the same new address', async () => {
    const a = await fixture();
    const b = await fixture();
    const pa = await prepare(a);
    const pb = await prepare(b, a.next);
    const results = await Promise.allSettled([service.verify(a.userId, pa.proof), service.verify(b.userId, pb.proof)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results[0].status === 'rejected' ? a : b;
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, message: 'WALLET_LINKED_TO_OTHER_ACCOUNT' } });
    await unchanged(loser);
    expect(await auditActions(db, 'user', loser.userId)).toEqual([]);
  });

  it.each(['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'FAILED'])('blocks %s payouts, including agent-owned submissions', async (status) => {
    const f = await fixture();
    const p = await payable(f, true);
    const payout = await rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    await db.query(`UPDATE payout SET status = $2 WHERE id = $1`, [payout.id, status]);
    await expect(prepare(f)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_PAYOUTS' });
    await unchanged(f);
  });

  it('rechecks payout blockers after signing and supports retry once an unsent payout is cancelled', async () => {
    const f = await fixture();
    const { proof } = await prepare(f);
    const p = await payable(f);
    const payout = await rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    await expect(service.verify(f.userId, proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_PAYOUTS' });
    await unchanged(f);
    await db.query(`UPDATE payout SET status = 'CANCELLED' WHERE id = $1`, [payout.id]);
    await expect(service.verify(f.userId, proof)).resolves.toMatchObject({ address: getInjectiveAddress(f.next.address) });
  });

  it('pays new rewards to the replacement wallet but mints completion NFTs to the existing parent wallet', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address, status, token_id)
      VALUES ($1, $2, 'NINJA_PARENT', 'c', 'MINTED', 'parent')`, [f.userId, f.walletId]);
    await service.verify(f.userId, (await prepare(f)).proof);
    const p = await payable(f);
    const payout = await rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    const approver = await createUser(db, { isAdmin: true });
    await rewards.markApproved(payout.id, approver);
    await rewards.markPaid(payout.id, fakeTxHash(), admin);
    expect((await db.query(`SELECT w.address FROM payout p JOIN wallet w ON w.id = p.recipient_wallet_id WHERE p.id = $1`, [payout.id])).rows[0].address)
      .toBe(getInjectiveAddress(f.next.address));
    expect((await db.query(`SELECT c.owner_wallet_id, p.owner_wallet_id AS parent_wallet_id FROM nft c JOIN nft p ON p.id = c.parent_nft_id WHERE c.submission_id = $1`, [p.submissionId])).rows)
      .toEqual([{ owner_wallet_id: f.walletId, parent_wallet_id: f.walletId }]);
  });

  it('blocks legacy recipient-wallet payouts and payouts of revoked/deleted agents', async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await payable(other, true);
    const payout = await rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    await db.query(`UPDATE payout SET status = 'FAILED', recipient_wallet_id = $2 WHERE id = $1`, [payout.id, f.walletId]);
    await db.query(`UPDATE agent SET status = 'REVOKED', deleted_at = now() WHERE id IN (SELECT agent_id FROM bounty_submission WHERE id = $1)`, [p.submissionId]);
    await expect(prepare(f)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_PAYOUTS' });
    await expect(prepare(other)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_PAYOUTS' });
  });

  it('rolls the complete swap back when audit persistence fails', async () => {
    const f = await fixture();
    const { challenge, proof } = await prepare(f);
    const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try { await expect(service.verify(f.userId, proof)).rejects.toThrow('audit unavailable'); }
    finally { spy.mockRestore(); }
    await unchanged(f);
    expect((await db.query(`SELECT completed_at FROM wallet_replacement_challenge WHERE id = $1`, [challenge.id])).rows[0].completed_at).toBeNull();
    expect((await db.query(`SELECT id FROM wallet WHERE user_id = $1`, [f.userId])).rowCount).toBe(1);
    await expect(service.verify(f.userId, proof)).resolves.toMatchObject({ address: getInjectiveAddress(f.next.address) });
  });

  it('does not acquire first-link challenge locks in the reverse order of legacy verification', async () => {
    const f = await fixture();
    const wallets = new WalletsService(db, new NftsService(db, testConfig()));
    const firstLink = await wallets.createChallenge(f.userId, f.old.address);
    const { proof } = await prepare(f);
    const entered = deferred();
    const gate = deferred();
    const legacy = db.tx(async (tx) => {
      await tx.query(`SELECT id FROM wallet_verification_challenge WHERE id = $1 FOR UPDATE`, [firstLink.id]);
      entered.resolve();
      await gate.promise;
      await tx.query(`SELECT id FROM "user" WHERE id = $1 FOR KEY SHARE`, [f.userId]);
    });
    await entered.promise;
    try { await expect(service.verify(f.userId, proof)).resolves.toMatchObject({ address: getInjectiveAddress(f.next.address) }); }
    finally { gate.resolve(); await legacy; }
    // A still-valid first-link proof cannot silently restore the old primary wallet.
    await expect(wallets.verifySignature(f.userId, f.old.address, await f.old.signMessage(firstLink.message)))
      .rejects.toMatchObject({ message: 'ACCOUNT_ALREADY_HAS_WALLET' });
  });

  it.each(['replacement-first', 'first-link-first'])('serializes actual first-link verification of the same replacement target: %s', async (order) => {
    const f = await fixture(), wallets = new WalletsService(db, new NftsService(db, testConfig()));
    const firstChallenge = await wallets.createChallenge(f.userId, f.next.address), { proof } = await prepare(f);
    const signature = await f.next.signMessage(firstChallenge.message), entered = deferred(), gate = deferred();
    const original = db.tx.bind(db); let paused = false;
    const spy = jest.spyOn(db, 'tx').mockImplementation((fn) => original(async (tx) => fn(new Proxy(tx, {
      get(target, prop) {
        if (prop !== 'query') return Reflect.get(target, prop);
        return async (sql: string, params: unknown[]) => {
          const result = await tx.query(sql, params);
          const stopHere = order === 'replacement-first' ? sql.startsWith('UPDATE wallet SET is_primary = false')
            : sql.startsWith('SELECT id FROM "user"');
          if (!paused && stopHere) { paused = true; entered.resolve(); await gate.promise; }
          return result;
        };
      },
    }))));
    const replace = () => service.verify(f.userId, proof), firstLink = () => wallets.verifySignature(f.userId, f.next.address, signature);
    const first = order === 'replacement-first' ? replace() : firstLink(); void first.catch(() => undefined);
    let second: ReturnType<typeof replace> | ReturnType<typeof firstLink> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw Error('race gate missed'); })]);
      second = order === 'replacement-first' ? firstLink() : replace(); void second.catch(() => undefined);
      await waitForLockWaiter(db, 'same-target first-link and replacement owner lock');
      const waiters = await db.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`);
      expect(waiters.rows.every((r) => r.query.startsWith('SELECT id FROM "user"'))).toBe(true);
      gate.resolve();
      if (order === 'replacement-first') {
        const result = await first; expect(await second).toMatchObject({ id: result.id });
      } else {
        await expect(first).rejects.toMatchObject({ status: 409, message: 'ACCOUNT_ALREADY_HAS_WALLET' });
        await expect(second).resolves.toMatchObject({ address: getInjectiveAddress(f.next.address) });
      }
      expect((await primary(f.userId))[0].address).toBe(getInjectiveAddress(f.next.address));
      expect((await db.query(`SELECT id FROM nft WHERE owner_user_id=$1`, [f.userId])).rowCount).toBe(0);
      expect(await auditActions(db, 'user', f.userId)).toEqual(['WALLET_REPLACED']);
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); spy.mockRestore(); }
  });

  it('does not accept a first-link proof that expires while waiting for the owner lock', async () => {
    const f = await fixture(), wallets = new WalletsService(db, new NftsService(db, testConfig()));
    const c = await wallets.createChallenge(f.userId, f.next.address), sig = await f.next.signMessage(c.message);
    const held = deferred(), gate = deferred();
    const lock = db.tx(async (tx) => { await tx.query(`SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, [f.userId]); held.resolve(); await gate.promise; });
    await held.promise; const verify = wallets.verifySignature(f.userId, f.next.address, sig); void verify.catch(() => undefined);
    try {
      await waitForLockWaiter(db, 'first-link proof awaiting owner');
      await db.query(`UPDATE wallet_verification_challenge SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1`, [c.id]);
      gate.resolve(); await lock;
      await expect(verify).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' }); await unchanged(f);
    } finally { gate.resolve(); await Promise.allSettled([lock, verify]); }
  });

  it('rolls back a swap when a request expires during the wallet insert, not just before validation', async () => {
    const f = await fixture();
    const { challenge, proof } = await prepare(f);
    // The isolated DB deliberately stalls this insert until after the short fixture expiry.
    await db.query(`CREATE FUNCTION test_slow_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER test_slow_replacement BEFORE INSERT ON wallet FOR EACH ROW EXECUTE FUNCTION test_slow_replacement()`);
    try {
      await db.query(`UPDATE wallet_replacement_challenge SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE id = $1`, [challenge.id]);
      const started = Date.now();
      await expect(service.verify(f.userId, proof)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    } finally {
      await db.query(`DROP TRIGGER test_slow_replacement ON wallet`);
      await db.query(`DROP FUNCTION test_slow_replacement()`);
    }
    await unchanged(f);
    expect((await db.query(`SELECT id FROM wallet WHERE user_id = $1`, [f.userId])).rowCount).toBe(1);
    expect((await db.query(`SELECT completed_at FROM wallet_replacement_challenge WHERE id = $1`, [challenge.id])).rows[0].completed_at).toBeNull();
    expect(await auditActions(db, 'user', f.userId)).toEqual([]);
  });

  it.each(['PENDING', 'MINTING', 'ATTACHING', 'FAILED'])('blocks unresolved %s NFTs even without a job', async (status) => {
    const f = await fixture();
    await db.query(`INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address, status) VALUES ($1, $2, 'NINJA_PARENT', 'c', $3)`, [f.userId, f.walletId, status]);
    await expect(prepare(f)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_NFT_JOBS' });
  });

  it.each(['PENDING', 'PROCESSING', 'FAILED'])('rechecks %s jobs on already minted NFTs after signing', async (status) => {
    const f = await fixture();
    const { proof } = await prepare(f);
    const nft = (await db.query(`INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address, status)
      VALUES ($1, $2, 'NINJA_PARENT', 'c', 'MINTED') RETURNING id`, [f.userId, f.walletId])).rows[0];
    await db.query(`INSERT INTO nft_job (nft_id, job_type, idempotency_key, status) VALUES ($1, 'ATTACH_CHILD', $2, $3)`, [nft.id, unique(), status]);
    await expect(service.verify(f.userId, proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_NFT_JOBS' });
    await unchanged(f);
  });

  it('rejects the owner\'s dedicated agent wallet even when stored as a 0x alias', async () => {
    const f = await fixture();
    await db.query(`INSERT INTO agent (owner_user_id, name, wallet_address) VALUES ($1, 'bot', $2)`, [f.userId, f.next.address]);
    await expect(prepare(f)).rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
  });

  it.each(['replacement-first', 'registration-first'])('serializes actual agent registration: %s', async (order) => {
    const f = await fixture(), { proof } = await prepare(f), agents = new AgentsService(db, audit);
    const entered = deferred(), gate = deferred();
    const originalAudit = audit.record.bind(audit);
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      await originalAudit(...args);
      if (order === 'replacement-first' && args[1] === 'WALLET_REPLACED' && args[3] === f.userId) { entered.resolve(); await gate.promise; }
    });
    const check = agents['assertNotOwnerWallet'].bind(agents);
    const checkSpy = jest.spyOn(agents as unknown as { assertNotOwnerWallet: typeof check }, 'assertNotOwnerWallet').mockImplementation(async (...args) => {
      await check(...args);
      if (order === 'registration-first') { entered.resolve(); await gate.promise; }
    });
    const register = () => agents.register(f.userId, 'bot', undefined, undefined, f.next.address);
    const replace = () => service.verify(f.userId, proof);
    const first = order === 'replacement-first' ? replace() : register();
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('gate missed'); })]);
      second = order === 'replacement-first' ? register() : replace(); void second.catch(() => undefined);
      await waitForLockWaiter(db, 'actual registration/replacement owner lock');
      gate.resolve(); await first;
      await expect(second).rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      if (order === 'registration-first') await unchanged(f);
      else expect((await primary(f.userId))[0].address).toBe(getInjectiveAddress(f.next.address));
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); auditSpy.mockRestore(); checkSpy.mockRestore(); }
  });

  it.each(['replacement-first', 'payout-first'])('serializes a concurrent payout request: %s', async (order) => {
    const f = await fixture();
    const p = await payable(f);
    const { proof } = await prepare(f);
    const gate = deferred();
    const entered = deferred();
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === (order === 'replacement-first' ? 'WALLET_REPLACED' : 'PAYOUT_REQUESTED')) { entered.resolve(); await gate.promise; }
    });
    const replace = () => service.verify(f.userId, proof);
    const payout = () => rewards.requestPayout(p.rewardId, p.submissionId, '10', admin);
    const first = order === 'replacement-first' ? replace() : payout();
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('missed pause'); })]);
      second = order === 'replacement-first' ? payout() : replace();
      void second.catch(() => undefined);
      await waitForLockWaiter(db, 'the competing payout/replacement');
      gate.resolve();
      await first;
      if (order === 'replacement-first') {
        await second;
        const row = (await db.query(`SELECT w.address FROM payout p JOIN wallet w ON w.id = p.recipient_wallet_id WHERE p.submission_id = $1`, [p.submissionId])).rows[0];
        expect(row.address).toBe(getInjectiveAddress(f.next.address));
      } else {
        await expect(second).rejects.toMatchObject({ message: 'WALLET_CHANGE_BLOCKED_PAYOUTS' });
        await unchanged(f);
      }
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); spy.mockRestore(); }
  });

  it('repairs a legacy joined-snapshot payout writer waiting behind replacement, including agent submissions', async () => {
    for (const agent of [false, true]) {
      const f = await fixture(), p = await payable(f, agent), { proof } = await prepare(f);
      const entered = deferred(), gate = deferred(), record = audit.record.bind(audit);
      const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
        await record(...args);
        if (args[1] === 'WALLET_REPLACED' && args[3] === f.userId) { entered.resolve(); await gate.promise; }
      });
      const replacement = service.verify(f.userId, proof);
      let legacy: Promise<{ selected: string; persisted: string }> | undefined;
      try {
        await Promise.race([entered.promise, replacement.then(() => { throw new Error('replacement gate missed'); })]);
        legacy = db.tx(async (tx) => {
          // Frozen pre-replacement writer shape, not the updated RewardsService.
          const wallet = await tx.query<{ wallet_id: string }>(
            `SELECT w.id AS wallet_id FROM bounty_submission s
               LEFT JOIN agent a ON a.id = s.agent_id
               JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id) AND u.deleted_at IS NULL
               JOIN wallet w ON w.user_id = u.id AND w.is_primary AND w.disconnected_at IS NULL AND w.verified_at IS NOT NULL
              WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2
              FOR UPDATE OF s FOR SHARE OF u`, [p.submissionId, p.bountyId]);
          const selected = wallet.rows[0].wallet_id;
          const inserted = await tx.query(`INSERT INTO payout
            (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by)
            VALUES ($1,$2,$3,10,$4,$5) RETURNING recipient_wallet_id`,
          [p.rewardId, p.submissionId, selected, unique(), admin]);
          return { selected, persisted: inserted.rows[0].recipient_wallet_id as string };
        });
        void legacy.catch(() => undefined);
        await waitForLockWaiter(db, 'legacy joined wallet snapshot');
        gate.resolve();
        const newWallet = await replacement, result = await legacy;
        expect(result).toEqual({ selected: f.walletId, persisted: newWallet.id });
        expect((await db.query(`SELECT receiving_wallet_revision FROM "user" WHERE id=$1`, [f.userId])).rows[0].receiving_wallet_revision).toBe('1');
      } finally { gate.resolve(); await Promise.allSettled([replacement, ...(legacy ? [legacy] : [])]); spy.mockRestore(); }
    }
  });

  it('keeps old child writers anchored after challenge cleanup and feature shutdown', async () => {
    const f = await fixture(), p = await payable(f);
    const parent = (await db.query(`INSERT INTO nft (owner_user_id,owner_wallet_id,nft_type,contract_address,status)
      VALUES ($1,$2,'NINJA_PARENT','c','MINTED') RETURNING id`, [f.userId, f.walletId])).rows[0];
    const { proof } = await prepare(f), replacement = await service.verify(f.userId, proof);
    await db.query(`DELETE FROM wallet_replacement_challenge WHERE user_id=$1`, [f.userId]);
    const child = await db.query(`INSERT INTO nft
      (owner_user_id,owner_wallet_id,parent_nft_id,bounty_id,submission_id,nft_type,contract_address)
      VALUES ($1,$2,$3,$4,$5,'BOUNTY_COMPLETION_CHILD','c') RETURNING owner_wallet_id,parent_nft_id`,
    [f.userId, replacement.id, parent.id, p.bountyId, p.submissionId]);
    expect(child.rows).toEqual([{ owner_wallet_id: f.walletId, parent_nft_id: parent.id }]);
    const disabled = new WalletReplacementService(db, audit, testConfig());
    await expect(disabled.verify(f.userId, proof)).rejects.toMatchObject({ message: 'WALLET_CHANGE_DISABLED' });
    expect((await primary(f.userId))[0].id).toBe(replacement.id);
  });

  it.each(['replacement-first', 'withdrawal-first'])('serializes account withdrawal: %s', async (order) => {
    const f = await fixture();
    const { proof } = await prepare(f);
    const entered = deferred();
    const gate = deferred();
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      await original(...args);
      if (args[1] === (order === 'replacement-first' ? 'WALLET_REPLACED' : 'USER_WITHDRAWN')) { entered.resolve(); await gate.promise; }
    });
    const change = () => service.verify(f.userId, proof);
    const withdraw = () => withdrawal.withdraw(f.userId, f.nickname);
    const first = order === 'replacement-first' ? change() : withdraw();
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('missed pause'); })]);
      second = order === 'replacement-first' ? withdraw() : change();
      void second.catch(() => undefined);
      await waitForLockWaiter(db, 'the competing withdrawal/replacement');
      gate.resolve();
      await first;
      if (order === 'replacement-first') await second;
      else await expect(second).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
      expect(await primary(f.userId)).toEqual([]);
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); spy.mockRestore(); }
  });

  it('expires requests while waiting for the owner lock and prunes old request records', async () => {
    const f = await fixture();
    const { challenge, proof } = await prepare(f);
    const entered = deferred();
    const gate = deferred();
    const locking = db.tx(async (tx) => { await tx.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [f.userId]); entered.resolve(); await gate.promise; });
    await entered.promise;
    const change = service.verify(f.userId, proof);
    void change.catch(() => undefined);
    try {
      await waitForLockWaiter(db, 'replacement to wait before expiry');
      await db.query(`UPDATE wallet_replacement_challenge SET expires_at = clock_timestamp() - interval '2 days' WHERE id = $1`, [challenge.id]);
    } finally { gate.resolve(); await locking; }
    await expect(change).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    await unchanged(f);
    await new MaintenanceService(db).sweep();
    expect((await db.query(`SELECT id FROM wallet_replacement_challenge WHERE id = $1`, [challenge.id])).rowCount).toBe(0);
  });
});
