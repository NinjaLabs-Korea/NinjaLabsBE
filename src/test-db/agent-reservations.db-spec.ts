import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred, waitForLockWaiter } from './harness';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('verified agent reservations across legacy and current writers', () => {
  let db: DatabaseService, agents: AgentsService;
  beforeAll(() => { db = createDb(); agents = new AgentsService(db, new AuditService(db)); });
  afterAll(async () => db.onApplicationShutdown());
  const key64 = (signer: ReturnType<typeof Wallet.createRandom>) => Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64');

  async function fixture() {
    const owner = await createUser(db), other = await createUser(db), signer = Wallet.createRandom();
    const original = (await db.query(`INSERT INTO agent(owner_user_id,name,wallet_address,public_key,status,verified_at)
      VALUES ($1,'original',$2,$3,'REVOKED',now()) RETURNING id`, [owner, getInjectiveAddress(signer.address), key64(signer)])).rows[0].id;
    return { owner, other, signer, original };
  }

  // Frozen critical SQL from dc806c7 register: raw-string reservation lookup,
  // NULL EVM pending key and the pre-existing named-23505 → 409 mapping.
  // No git-show dependency: this regression must also run on shallow CI clones.
  async function legacyRegister(owner: string, address: string) {
    try {
      return await db.tx(async (tx) => {
        const rows = await tx.query(`SELECT owner_user_id, verified_at FROM agent
          WHERE (wallet_address=$1 OR ($2::text IS NOT NULL AND public_key=$2::text))
          AND status IN ('REVOKED','PENDING_VERIFICATION') AND deleted_at IS NULL FOR UPDATE`, [address, null]);
        if (rows.rows.some((r) => r.verified_at && r.owner_user_id !== owner)) throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
        return (await tx.query(`INSERT INTO agent(owner_user_id,name,description,public_key,wallet_address)
          VALUES ($1,'legacy',NULL,NULL,$2) RETURNING id`, [owner, address])).rows[0].id as string;
      });
    } catch (error) {
      if (isUniqueViolation(error, ['uq_agent_wallet', 'uq_agent_public_key'])) throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
      throw error;
    }
  }

  it('blocks legacy alias registration at the DB boundary, preserves history, and lets the original owner re-register', async () => {
    const f = await fixture();
    await expect(legacyRegister(f.other, f.signer.address)).rejects.toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    const mine = await legacyRegister(f.owner, f.signer.address);
    await expect(agents.verifyAndIssueKey(f.owner, mine, await f.signer.signMessage(AgentsService.verificationMessage(mine, f.owner))))
      .resolves.toMatchObject({ status: 'ACTIVE' });
    expect((await db.query(`SELECT owner_user_id,status FROM agent WHERE id=$1`, [f.original])).rows[0])
      .toEqual({ owner_user_id: f.owner, status: 'REVOKED' });
    expect((await db.query(`SELECT id FROM agent WHERE owner_user_id=$1`, [f.other])).rowCount).toBe(0);
  });

  it('rejects a pre-guard pending alias in both current verification and legacy activation, without issuing a key', async () => {
    const f = await fixture();
    // Simulate a pre-upgrade row only inside this isolated test DB. DDL/seed/
    // re-enable are atomic; a failed seed rolls the trigger state back as well.
    const pending = await db.tx(async (tx) => {
      await tx.query(`ALTER TABLE agent DISABLE TRIGGER trg_agent_identity_reservation`);
      await tx.query(`ALTER TABLE agent DISABLE TRIGGER trg_agent_identity_reservation_after`);
      const result = await tx.query(`INSERT INTO agent(owner_user_id,name,wallet_address) VALUES ($1,'pre-guard',$2) RETURNING id`, [f.other, f.signer.address]);
      await tx.query(`ALTER TABLE agent ENABLE TRIGGER trg_agent_identity_reservation`);
      await tx.query(`ALTER TABLE agent ENABLE TRIGGER trg_agent_identity_reservation_after`);
      return result.rows[0].id as string;
    });
    const writes: string[] = [], original = db.tx.bind(db);
    const spy = jest.spyOn(db, 'tx').mockImplementation((fn) => original(async (tx) => fn(new Proxy(tx, { get(target, prop) {
      if (prop !== 'query') return Reflect.get(target, prop);
      return async (sql: string, params: unknown[]) => { if (/^(UPDATE|INSERT|DELETE)/.test(sql.trim())) writes.push(sql); return tx.query(sql, params); };
    } }))));
    try {
      const sig = await f.signer.signMessage(AgentsService.verificationMessage(pending, f.other));
      await expect(agents.verifyAndIssueKey(f.other, pending, sig)).rejects.toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect(writes).toEqual([]); // application guard rejects before any cleanup/activation
    } finally { spy.mockRestore(); }
    // Exact legacy verified state mutation, bypassing the new application guard.
    await expect(db.query(`UPDATE agent SET status='ACTIVE',verified_at=now(),public_key=$2 WHERE id=$1`, [pending, f.signer.signingKey.compressedPublicKey]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_agent_public_key' });
    expect((await db.query(`SELECT status FROM agent WHERE id=$1`, [pending])).rows[0].status).toBe('PENDING_VERIFICATION');
    expect((await db.query(`SELECT id FROM agent_api_key WHERE agent_id=$1`, [pending])).rowCount).toBe(0);
    await db.query(`UPDATE agent SET status='REVOKED' WHERE id=$1`, [pending]); // unverified conflict remains cleanable
  });

  it('does not reserve an unverified revoked squatter account', async () => {
    const owner = await createUser(db), other = await createUser(db), signer = Wallet.createRandom();
    await db.query(`INSERT INTO agent(owner_user_id,name,wallet_address,status) VALUES ($1,'unproven',$2,'REVOKED')`, [other, signer.address]);
    const pending = await legacyRegister(owner, signer.address);
    await expect(agents.verifyAndIssueKey(owner, pending, await signer.signMessage(AgentsService.verificationMessage(pending, owner))))
      .resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('rechecks a legacy INSERT after it waited for a newly verified then revoked identity', async () => {
    const owner = await createUser(db), other = await createUser(db), signer = Wallet.createRandom();
    const pending = (await db.query(`INSERT INTO agent(owner_user_id,name,wallet_address,public_key)
      VALUES ($1,'before-proof',$2,$3) RETURNING id`, [owner, getInjectiveAddress(signer.address), key64(signer)])).rows[0].id;
    const entered = deferred(), gate = deferred();
    // Collapse two valid state transitions into a controlled transaction so a
    // waiting legacy INSERT deterministically sees the final REVOKED row.
    const verifyThenRevoke = db.tx(async (tx) => {
      await tx.query(`UPDATE agent SET status='ACTIVE',verified_at=now() WHERE id=$1`, [pending]);
      await tx.query(`UPDATE agent SET status='REVOKED' WHERE id=$1`, [pending]);
      entered.resolve(); await gate.promise;
    });
    let legacy: Promise<string> | undefined;
    try {
      await entered.promise;
      legacy = legacyRegister(other, signer.address); void legacy.catch(() => undefined);
      await waitForLockWaiter(db, 'legacy alias INSERT waiting for proof/revoke');
      gate.resolve(); await verifyThenRevoke;
      await expect(legacy).rejects.toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect((await db.query(`SELECT id FROM agent WHERE owner_user_id=$1`, [other])).rowCount).toBe(0);
    } finally { gate.resolve(); await Promise.allSettled([verifyThenRevoke, ...(legacy ? [legacy] : [])]); }
  });

  it.each(['clean', 'two-revoked-owners', 'legacy-pending-other-owner'])('backfills or rejects a populated pre-guard schema atomically: %s', async (kind) => {
    const schema = `agent_reserve_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID(), signer = Wallet.createRandom();
    const migration = readFileSync(join(__dirname, '../../supabase/migrations/0028_agent_identity_reservations.sql'), 'utf8');
    await db.tx(async (tx) => {
      await tx.query(`CREATE SCHEMA "${schema}"`);
      await tx.query(`SET LOCAL search_path TO "${schema}", public, pg_catalog`);
      await tx.query(`CREATE TABLE "user"(id uuid PRIMARY KEY)`);
      await tx.query(`INSERT INTO "user" VALUES ($1),($2)`, [owner, other]);
      await tx.query(`CREATE TABLE agent(owner_user_id uuid,wallet_address text,public_key text,status text,verified_at timestamptz,deleted_at timestamptz)`);
      await tx.query(`INSERT INTO agent VALUES ($1,$2,$3,'REVOKED',now(),NULL)`, [owner, getInjectiveAddress(signer.address), key64(signer)]);
      if (kind !== 'clean') await tx.query(`INSERT INTO agent VALUES ($1,$2,NULL,$3,CASE WHEN $3='REVOKED' THEN now() END,NULL)`,
        [other, signer.address, kind === 'two-revoked-owners' ? 'REVOKED' : 'PENDING_VERIFICATION']);
      const before = (await tx.query(`SELECT * FROM agent ORDER BY owner_user_id`)).rows;
      await tx.query('SAVEPOINT upgrade');
      if (kind === 'clean') {
        await tx.query(migration);
        expect((await tx.query(`SELECT owner_user_id FROM agent_identity_reservation ORDER BY identity`)).rows).toEqual([{ owner_user_id: owner }, { owner_user_id: owner }]);
        await expect(tx.query(`INSERT INTO agent VALUES ($1,$2,NULL,'PENDING_VERIFICATION',NULL,NULL)`, [other, signer.address]))
          .rejects.toMatchObject({ code: '23505', constraint: 'uq_agent_public_key' });
      } else await expect(tx.query(migration)).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('AGENT_CANONICAL_RESERVATION_CONFLICT') });
      await tx.query('ROLLBACK TO SAVEPOINT upgrade');
      expect((await tx.query(`SELECT * FROM agent ORDER BY owner_user_id`)).rows).toEqual(before);
      expect((await tx.query(`SELECT to_regclass($1) AS table`, [`${schema}.agent_identity_reservation`])).rows[0].table).toBeNull();
      await tx.query(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });
});
