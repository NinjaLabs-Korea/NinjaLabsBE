import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred } from './harness';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('canonical agent identity and production migration compatibility', () => {
  let db: DatabaseService;
  let agents: AgentsService;
  beforeAll(() => { db = createDb(); agents = new AgentsService(db, new AuditService(db)); });
  afterAll(async () => db.onApplicationShutdown());
  const key64 = (signer: ReturnType<typeof Wallet.createRandom>) => Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64');

  it('SQL and signing helpers agree on EVM/bech32 account bytes and legacy/new key encodings', async () => {
    const privileges = (await db.query(`SELECT NOT EXISTS (
      SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.oid = 'agent_account_key(text)'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
      ) AS internal_only`)).rows[0];
    expect(privileges.internal_only).toBe(true);
    for (let i = 0; i < 25; i++) {
      const signer = Wallet.createRandom();
      const inj = getInjectiveAddress(signer.address);
      const row = (await db.query(`SELECT agent_account_key($1) AS evm, agent_account_key($2) AS inj,
        agent_account_key(upper($2)) AS upper_inj, agent_public_key_id($3) AS hex, agent_public_key_id($4) AS b64`,
      [signer.address, inj, signer.signingKey.compressedPublicKey, key64(signer)])).rows[0];
      expect(row).toEqual({ evm: signer.address.toLowerCase(), inj: signer.address.toLowerCase(), upper_inj: signer.address.toLowerCase(), hex: signer.signingKey.compressedPublicKey.slice(2), b64: signer.signingKey.compressedPublicKey.slice(2) });
      expect((await db.query(`SELECT agent_account_key($1) AS bad`, [inj.slice(0, -1) + (inj.endsWith('q') ? 'p' : 'q')])).rows[0].bad).toBeNull();
    }
  });

  it.each(['EVM', 'ADR36'])('a %s registration cannot be duplicated through its other address spelling', async (first) => {
    const owner = await createUser(db);
    const other = await createUser(db);
    const signer = Wallet.createRandom();
    const inj = getInjectiveAddress(signer.address);
    const input = first === 'EVM' ? [undefined, signer.address] : [key64(signer), inj];
    const initial = await agents.register(owner, 'first', undefined, input[0], input[1]!);
    if (first === 'EVM') await agents.verifyAndIssueKey(owner, initial.agentId, await signer.signMessage(initial.verificationMessage));
    const second = first === 'EVM' ? [key64(signer), inj] : [undefined, signer.address];
    await expect(agents.register(other, 'alias', undefined, second[0], second[1]!)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    await expect(agents.register(owner, 'same-owner-alias', undefined, second[0], second[1]!)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    expect((await db.query(`SELECT count(*)::int AS n FROM agent WHERE owner_user_id = $1`, [other])).rows[0].n).toBe(0);
  });

  it('concurrent cross-scheme registrations have exactly one winner', async () => {
    const a = await createUser(db), b = await createUser(db), signer = Wallet.createRandom();
    const outcomes = await Promise.allSettled([
      agents.register(a, 'evm', undefined, undefined, signer.address),
      agents.register(b, 'adr', undefined, key64(signer), getInjectiveAddress(signer.address)),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' } });
  });

  it('a verified REVOKED reservation also matches aliases, while the original owner can re-register', async () => {
    const owner = await createUser(db), other = await createUser(db), signer = Wallet.createRandom();
    const initial = await agents.register(owner, 'evm', undefined, undefined, signer.address);
    await agents.verifyAndIssueKey(owner, initial.agentId, await signer.signMessage(initial.verificationMessage));
    await agents.revoke(owner, initial.agentId);
    await expect(agents.register(other, 'alias', undefined, key64(signer), getInjectiveAddress(signer.address))).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    await expect(agents.register(owner, 'mine', undefined, key64(signer), getInjectiveAddress(signer.address))).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
  });

  it('rejects a reserved alias even while its verified revocation is uncommitted', async () => {
    const owner = await createUser(db), other = await createUser(db), signer = Wallet.createRandom();
    const audit = new AuditService(db), local = new AgentsService(db, audit);
    const initial = await local.register(owner, 'old', undefined, undefined, signer.address);
    await local.verifyAndIssueKey(owner, initial.agentId, await signer.signMessage(initial.verificationMessage));
    const entered = deferred(), gate = deferred(), record = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      if (args[1] === 'AGENT_REVOKED' && args[3] === initial.agentId) { entered.resolve(); await gate.promise; }
      await record(...args);
    });
    const revoke = local.revoke(owner, initial.agentId);
    let register: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, revoke.then(() => { throw new Error('gate missed'); })]);
      register = agents.register(other, 'alias', undefined, key64(signer), getInjectiveAddress(signer.address));
      void register.catch(() => undefined);
      await expect(register).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      gate.resolve(); await revoke;
      expect((await db.query(`SELECT count(*)::int AS n FROM agent WHERE owner_user_id=$1`, [other])).rows[0].n).toBe(0);
    } finally { gate.resolve(); await Promise.allSettled([revoke, ...(register ? [register] : [])]); spy.mockRestore(); }
  });

  it.each(['account-alias', 'key-encoding', 'verified-reservation'])('migration stops on %s without deleting rows or replacing old indexes', async (kind) => {
    const schema = `agent_migration_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(join(__dirname, '../../supabase/migrations/0025_agent_canonical_identity.sql'), 'utf8');
    const signer = Wallet.createRandom();
    await db.tx(async (tx) => {
      await tx.query(`CREATE SCHEMA "${schema}"`);
      await tx.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await tx.query(`CREATE TABLE agent (wallet_address text, public_key text, status text, deleted_at timestamptz, owner_user_id uuid, verified_at timestamptz)`);
      await tx.query(`CREATE UNIQUE INDEX uq_agent_wallet ON agent(wallet_address) WHERE deleted_at IS NULL AND status <> 'REVOKED'`);
      await tx.query(`CREATE UNIQUE INDEX uq_agent_public_key ON agent(public_key) WHERE deleted_at IS NULL AND status <> 'REVOKED'`);
      await tx.query(`INSERT INTO agent (wallet_address,public_key,status,owner_user_id,verified_at)
        VALUES ($1,$2,$5,$6,now()),($3,$4,'ACTIVE',$7,NULL)`, [signer.address, signer.signingKey.compressedPublicKey,
        kind === 'key-encoding' ? Wallet.createRandom().address : getInjectiveAddress(signer.address), key64(signer),
        kind === 'verified-reservation' ? 'REVOKED' : 'ACTIVE', randomUUID(), randomUUID()]);
      await tx.query('SAVEPOINT migration_attempt');
      await expect(tx.query(migration)).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('AGENT_CANONICAL_IDENTITY_CONFLICT') });
      await tx.query('ROLLBACK TO SAVEPOINT migration_attempt');
      expect((await tx.query(`SELECT count(*)::int AS n FROM agent`)).rows[0].n).toBe(2);
      const index = (await tx.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'uq_agent_wallet'`, [schema])).rows[0].indexdef;
      expect(index).not.toContain('agent_account_key');
      await tx.query(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });

  it('an existing verified revoked row and same-owner active alias upgrade without rewriting history', async () => {
    const schema = `agent_upgrade_${randomUUID().replaceAll('-', '')}`, signer = Wallet.createRandom(), owner = randomUUID();
    const migration = readFileSync(join(__dirname, '../../supabase/migrations/0025_agent_canonical_identity.sql'), 'utf8');
    await db.tx(async (tx) => {
      await tx.query(`CREATE SCHEMA "${schema}"`);
      await tx.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await tx.query(`CREATE TABLE agent (wallet_address text, public_key text, status text, deleted_at timestamptz, owner_user_id uuid, verified_at timestamptz)`);
      await tx.query(`CREATE UNIQUE INDEX uq_agent_wallet ON agent(wallet_address) WHERE deleted_at IS NULL AND status <> 'REVOKED'`);
      await tx.query(`CREATE UNIQUE INDEX uq_agent_public_key ON agent(public_key) WHERE deleted_at IS NULL AND status <> 'REVOKED'`);
      await tx.query(`INSERT INTO agent (wallet_address,public_key,status,owner_user_id,verified_at)
        VALUES ($1,$2,'REVOKED',$5,now()),($3,$4,'ACTIVE',$5,now())`, [signer.address, signer.signingKey.compressedPublicKey, getInjectiveAddress(signer.address), key64(signer), owner]);
      const before = (await tx.query(`SELECT * FROM agent ORDER BY status`)).rows;
      await tx.query(migration);
      expect((await tx.query(`SELECT * FROM agent ORDER BY status`)).rows).toEqual(before);
      expect((await tx.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='uq_agent_wallet'`, [schema])).rows[0].indexdef).toContain('agent_account_key');
      await tx.query(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });
});
