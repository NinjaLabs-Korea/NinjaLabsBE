import { AuditService } from '../audit/audit.service';
import { createMockDb, SqlHandler } from '../test-support/mock-db';
import { AgentsService } from './agents.service';

// sdk-ts is ESM-only: the e2e stub implements the inj1 <-> 0x helpers with real bech32 (byte-identical to sdk-ts)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({
  verifyAdr36Signature: jest.fn(() => false),
}));

class TestAgentsService extends AgentsService {
  protected generateApiKey() {
    return { raw: 'nj_test_key', prefix: 'nj_test_key', hash: 'test-hash' };
  }
}

/**
 * 단위 스펙은 회전/폐기의 상태 게이트와 호출 인자(잠금 범위, 키 해시 바인딩, 같은 트랜잭션 감사)만 본다. 키가 실제로 어떻게 바뀌는지(ACTIVE 키 전부 폐기, 90일 만료, 감사 행, 멱등 폐기,
 * 남의 에이전트 404, 내 에이전트 목록의 키 선택과 key_status), 등록과 검증의 행 효과(지갑/키 점유, 24시간 선점 정리, 동시 검증)는
 * src/test-db/agents-register.db-spec.ts와 agents.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드라 게이트 뒤의 문장(키 폐기, 삽입)은 상태가 맞을 때만 등록된다.
 */
describe('AgentsService key rotation and revocation', () => {
  const agentId = '11111111-1111-4111-8111-111111111111';
  const ownerUserId = '22222222-2222-4222-8222-222222222222';
  const ok = { rowCount: 1, rows: [] };

  function setup(status: string | null) {
    const handlers: SqlHandler[] = [
      { match: /FOR UPDATE$/, reply: () => (status ? { rowCount: 1, rows: [{ status }] } : { rowCount: 0, rows: [] }) },
      { match: /^UPDATE agent_api_key SET status = 'REVOKED'/, reply: () => ok },
      { match: /^UPDATE agent SET status = 'REVOKED'/, reply: () => ok },
      { match: /^INSERT INTO agent_api_key/, reply: () => ({ rowCount: 1, rows: [{ expires_at: '2027-01-20T00:00:00.000Z' }] }) },
      { match: /^INSERT INTO audit_log/, reply: () => ok },
    ];
    const mock = createMockDb({ strict: true, handlers });
    const service = new TestAgentsService(mock.database, new AuditService(mock.database));
    return { mock, service };
  }

  it('rotates in one transaction: the owned agent is locked by (id, owner), one key is inserted by prefix and hash, and the rotation is audited with the same tx', async () => {
    const { mock, service } = setup('ACTIVE');
    await expect(service.rotateKey(ownerUserId, agentId)).resolves.toEqual({
      agentId, apiKey: 'nj_test_key', expiresAt: '2027-01-20T00:00:00.000Z',
    });
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.db.query).not.toHaveBeenCalled();
    expect(mock.txStatements(/FOR UPDATE$/)[0].params).toEqual([agentId, ownerUserId]);
    expect(mock.txStatements(/^UPDATE agent_api_key SET status = 'REVOKED'/)[0].params).toEqual([agentId]);
    expect(mock.txStatements(/^INSERT INTO agent_api_key/)[0].params).toEqual([agentId, 'nj_test_key', 'test-hash']);
    expect(mock.txStatements(/^INSERT INTO audit_log/)[0].params).toEqual([ownerUserId, 'AGENT_KEY_ROTATED', 'agent', agentId]);
  });

  it.each([
    ['PENDING_VERIFICATION', 'AGENT_NOT_ACTIVE'],
    ['REVOKED', 'AGENT_NOT_ACTIVE'],
    [null, 'AGENT_NOT_FOUND'],
  ])('refuses to rotate when the agent status is %s (%s) before touching any key', async (status, code) => {
    const { service, mock } = setup(status);
    await expect(service.rotateKey(ownerUserId, agentId)).rejects.toMatchObject({ message: code });
    expect(mock.txQuery).toHaveBeenCalledTimes(1);
  });

  it('revokes the agent and its keys and audits inside the same transaction', async () => {
    const { service, mock } = setup('ACTIVE');
    await expect(service.revoke(ownerUserId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
    expect(mock.txStatements(/^UPDATE agent SET status = 'REVOKED'/)[0].params).toEqual([agentId]);
    expect(mock.txStatements(/^UPDATE agent_api_key SET status = 'REVOKED'/)[0].params).toEqual([agentId]);
    expect(mock.txStatements(/^INSERT INTO audit_log/)[0].params).toEqual([ownerUserId, 'AGENT_REVOKED', 'agent', agentId]);
    expect(mock.db.query).not.toHaveBeenCalled();
  });

  it('is idempotent: revoking an already revoked agent writes nothing and returns the same body', async () => {
    const { service, mock } = setup('REVOKED');
    await expect(service.revoke(ownerUserId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
    expect(mock.txQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects revoking an agent the caller does not own', async () => {
    const { service } = setup(null);
    await expect(service.revoke(ownerUserId, agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
  });

  it('myAgents reads through the pool with only the owner id bound and returns the rows as they are', async () => {
    const rows = [{ id: agentId, key_status: 'EXPIRED' }];
    const mock = createMockDb({ strict: true, handlers: [{ match: /^SELECT a\.id, a\.name/, reply: () => ({ rowCount: 1, rows }) }] });
    const service = new AgentsService(mock.database, new AuditService(mock.database));
    await expect(service.myAgents(ownerUserId)).resolves.toBe(rows);
    expect(mock.statements(/./)[0].params).toEqual([ownerUserId]);
    expect(mock.db.tx).not.toHaveBeenCalled();
  });
});
