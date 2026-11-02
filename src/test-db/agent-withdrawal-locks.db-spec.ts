import { JwtService } from '@nestjs/jwt';
import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred, TEST_JWT_SECRET, testConfig, unique, waitForLockWaiter } from './harness';
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('owner-before-agent locks under account withdrawal', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let agents: AgentsService;
  let withdrawal: AccountWithdrawalService;
  beforeAll(() => {
    db = createDb(); audit = new AuditService(db); agents = new AgentsService(db, audit);
    withdrawal = new AccountWithdrawalService(db, audit, new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET }), testConfig(), TEST_JWT_SECRET));
  });
  afterAll(async () => db.onApplicationShutdown());
  it.each(['verify', 'rotate', 'revoke'] as const)('serializes withdrawal after %s without FK deadlock', async (action) => {
    const nickname = unique('locks_'), owner = await createUser(db, { nickname }), signer = Wallet.createRandom();
    const pending = await agents.register(owner, 'bot', undefined, undefined, signer.address);
    const signature = await signer.signMessage(pending.verificationMessage);
    if (action !== 'verify') await agents.verifyAndIssueKey(owner, pending.agentId, signature);
    const entered = deferred(), gate = deferred(), original = audit.record.bind(audit);
    const wanted = { verify: 'AGENT_VERIFIED', rotate: 'AGENT_KEY_ROTATED', revoke: 'AGENT_REVOKED' }[action];
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      if (args[1] === wanted && args[3] === pending.agentId) { entered.resolve(); await gate.promise; }
      await original(...args);
    });
    const first = action === 'verify' ? agents.verifyAndIssueKey(owner, pending.agentId, signature) : action === 'rotate' ? agents.rotateKey(owner, pending.agentId) : agents.revoke(owner, pending.agentId);
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('audit gate missed'); })]);
      second = withdrawal.withdraw(owner, nickname); void second.catch(() => undefined);
      await waitForLockWaiter(db, 'withdrawal behind owner lock');
      gate.resolve(); await first; await second;
      expect((await db.query(`SELECT status FROM agent WHERE id = $1`, [pending.agentId])).rows[0].status).toBe('REVOKED');
      expect((await db.query(`SELECT count(*)::int AS n FROM agent_api_key WHERE agent_id = $1 AND status = 'ACTIVE'`, [pending.agentId])).rows[0].n).toBe(0);
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); spy.mockRestore(); }
  });

  it.each(['verify', 'rotate', 'revoke'] as const)('refuses %s after withdrawal wins the owner lock', async (action) => {
    const nickname = unique('withdraw_'), owner = await createUser(db, { nickname }), signer = Wallet.createRandom();
    const pending = await agents.register(owner, 'bot', undefined, undefined, signer.address);
    const signature = await signer.signMessage(pending.verificationMessage);
    if (action !== 'verify') await agents.verifyAndIssueKey(owner, pending.agentId, signature);
    const entered = deferred(), gate = deferred(), original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      if (args[1] === 'USER_WITHDRAWN' && args[3] === owner) { entered.resolve(); await gate.promise; }
      await original(...args);
    });
    const first = withdrawal.withdraw(owner, nickname);
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('audit gate missed'); })]);
      second = action === 'verify' ? agents.verifyAndIssueKey(owner, pending.agentId, signature) : action === 'rotate' ? agents.rotateKey(owner, pending.agentId) : agents.revoke(owner, pending.agentId);
      void second.catch(() => undefined);
      await waitForLockWaiter(db, 'agent mutation behind withdrawal');
      gate.resolve(); await first;
      await expect(second).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    } finally { gate.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); spy.mockRestore(); }
  });
});
