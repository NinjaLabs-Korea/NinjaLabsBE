import { AuditService } from '../audit/audit.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { revokeActiveAgentKeys, revokeAllAgentsOfOwner } from './agent-revocation';

describe('agent-revocation', () => {
  function setup(revokedAgentIds: string[] = []) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes('UPDATE agent SET') ? { rowCount: revokedAgentIds.length, rows: revokedAgentIds.map((id) => ({ id })) } : { rowCount: 0, rows: [] },
    );
    const tx = { query: withParamsCheck(query) };
    const record = jest.fn().mockResolvedValue(undefined);
    return { query, tx, record, audit: { record } as unknown as AuditService };
  }

  it('revokeActiveAgentKeys revokes only the ACTIVE keys of one agent', async () => {
    const { query, tx } = setup();
    await revokeActiveAgentKeys(tx, 'a1');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`UPDATE agent_api_key SET status = 'REVOKED', revoked_at = now()`);
    expect(sql).toContain(`agent_id = $1 AND status = 'ACTIVE'`);
    expect(params).toEqual(['a1']);
  });

  it('revokeAllAgentsOfOwner revokes agents, then every owned ACTIVE key, then audits each newly revoked agent in order', async () => {
    const { query, tx, record, audit } = setup(['a1', 'a2']);
    await expect(revokeAllAgentsOfOwner(tx, audit, 'owner', 'actor')).resolves.toEqual(['a1', 'a2']);

    const [agentSql, keySql] = query.mock.calls.map(([sql]) => sql);
    expect(agentSql).toContain(`WHERE owner_user_id = $1 AND deleted_at IS NULL AND status <> 'REVOKED'`);
    expect(keySql).toContain(`agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1))`);
    expect(query.mock.calls.map(([, params]) => params)).toEqual([['owner'], ['owner']]);
    expect(record.mock.calls).toEqual([
      ['actor', 'AGENT_REVOKED', 'agent', 'a1', tx],
      ['actor', 'AGENT_REVOKED', 'agent', 'a2', tx],
    ]);
  });

  it('revokeAllAgentsOfOwner still revokes leftover keys but writes no audit row when no agent changed', async () => {
    const { query, tx, record, audit } = setup([]);
    await expect(revokeAllAgentsOfOwner(tx, audit, 'owner', 'owner')).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
  });
});
