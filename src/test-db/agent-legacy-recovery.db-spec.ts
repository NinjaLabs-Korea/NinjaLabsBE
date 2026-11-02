import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred } from './harness';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('legacy agent cross-keys and committed credential response loss', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onApplicationShutdown());

  it('verifies both cross-populated legacy pending keys without a deadlock or extra active keys', async () => {
    const owners = await Promise.all([createUser(db), createUser(db)]), signers = [Wallet.createRandom(), Wallet.createRandom()];
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await db.query(`INSERT INTO agent (owner_user_id,name,wallet_address,public_key)
      VALUES ($1,'legacy',$2,$3) RETURNING id`, [owners[i], signers[i].address, signers[1 - i].signingKey.compressedPublicKey])).rows[0].id);
    const barrier = deferred(); let reads = 0;
    const original = db.tx.bind(db);
    const spy = jest.spyOn(db, 'tx').mockImplementation((fn) => original(async (tx) => {
      const query = tx.query.bind(tx);
      const wrapped = new Proxy(tx, { get(target, prop) {
        if (prop !== 'query') return Reflect.get(target, prop);
        return async (sql: string, params: unknown[]) => {
          const result = await query(sql, params);
          if (/SELECT status, public_key, wallet_address, verified_at FROM agent/.test(sql)) {
            if (++reads === 2) barrier.resolve();
            await barrier.promise;
          }
          return result;
        };
      } });
      return fn(wrapped);
    }));
    try {
      const service = new AgentsService(db, new AuditService(db));
      const results = await Promise.all(ids.map(async (id, i) => service.verifyAndIssueKey(owners[i], id,
        await signers[i].signMessage(AgentsService.verificationMessage(id, owners[i])))));
      expect(results.map((r) => r.status)).toEqual(['ACTIVE', 'ACTIVE']);
      const rows = (await db.query(`SELECT id, public_key, status FROM agent WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
      for (let i = 0; i < 2; i++) expect(rows.find((r) => r.id === ids[i])).toMatchObject({ status: 'ACTIVE', public_key: Buffer.from(signers[i].signingKey.compressedPublicKey.slice(2), 'hex').toString('base64') });
      expect((await db.query(`SELECT count(*)::int AS n FROM agent_api_key WHERE agent_id=ANY($1::uuid[]) AND status='ACTIVE'`, [ids])).rows[0].n).toBe(2);
    } finally { barrier.resolve(); spy.mockRestore(); }
  });

  it('recovers a lost verify or rotate response through owner rotation without storing a raw API key', async () => {
    const owner = await createUser(db), signer = Wallet.createRandom(), audit = new AuditService(db), service = new AgentsService(db, audit);
    const pending = await service.register(owner, 'bot', undefined, undefined, signer.address);
    const signature = await signer.signMessage(pending.verificationMessage);
    const original = db.tx.bind(db);
    const loseNextCommit = () => jest.spyOn(db, 'tx').mockImplementationOnce(async (fn) => {
      await original(fn); throw new Error('SIMULATED_LOST_COMMIT_ACK');
    });
    let spy = loseNextCommit();
    await expect(service.verifyAndIssueKey(owner, pending.agentId, signature)).rejects.toThrow('SIMULATED_LOST_COMMIT_ACK');
    spy.mockRestore();
    await expect(service.verifyAndIssueKey(owner, pending.agentId, signature)).rejects.toMatchObject({ message: 'AGENT_ALREADY_VERIFIED' });
    const first = await service.rotateKey(owner, pending.agentId);
    spy = loseNextCommit();
    await expect(service.rotateKey(owner, pending.agentId)).rejects.toThrow('SIMULATED_LOST_COMMIT_ACK');
    spy.mockRestore();
    const recovered = await service.rotateKey(owner, pending.agentId);
    expect(recovered.apiKey).not.toBe(first.apiKey);
    const keys = (await db.query(`SELECT key_hash,status FROM agent_api_key WHERE agent_id=$1`, [pending.agentId])).rows;
    expect(keys).toHaveLength(4);
    expect(keys.filter((k) => k.status === 'ACTIVE')).toHaveLength(1);
    expect(JSON.stringify(keys)).not.toContain(recovered.apiKey);
  });
});
