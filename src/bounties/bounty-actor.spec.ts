import { BountyActor } from './bounty-actor';
import { createMockDb, normalizeSql } from '../test-support/mock-db';

describe('BountyActor', () => {
  it('maps a user to user columns', () => {
    const actor = BountyActor.user('u1');
    expect([actor.userId, actor.agentId]).toEqual(['u1', null]);
    expect(actor.applicationColumn).toBe('applicant_user_id');
    expect(actor.submissionColumn).toBe('submitter_user_id');
  });

  it('maps an agent to agent columns', () => {
    const actor = BountyActor.agent('a1');
    expect([actor.userId, actor.agentId]).toEqual([null, 'a1']);
    expect(actor.applicationColumn).toBe('agent_id');
    expect(actor.submissionColumn).toBe('agent_id');
  });

  it('enforces the bounty submission mode', () => {
    expect(() => BountyActor.user('u').assertAllowedBy('AGENT')).toThrow('AGENT_SUBMISSION_REQUIRED');
    expect(() => BountyActor.agent('a').assertAllowedBy('DIRECT')).toThrow('DIRECT_SUBMISSION_REQUIRED');
    expect(() => BountyActor.user('u').assertAllowedBy('DIRECT')).not.toThrow();
    expect(() => BountyActor.agent('a').assertAllowedBy('AGENT')).not.toThrow();
  });

  describe.each(['USER', 'AGENT'] as const)('%s eligibility', (kind) => {
    const actor = () => kind === 'USER' ? BountyActor.user('u') : BountyActor.agent('a');

    it('checks active onboarding and locks only the user or owner in the supplied transaction', async () => {
      const mock = createMockDb();
      mock.txQuery.mockResolvedValue({ rowCount: 1, rows: [{ done: true }] });
      await expect(actor().assertOnboarded(mock.txClient)).resolves.toBeUndefined();
      expect(mock.query).not.toHaveBeenCalled();
      expect(mock.txQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mock.txQuery.mock.calls[0];
      expect(normalizeSql(sql)).toContain(kind === 'USER'
        ? "deleted_at IS NULL AND status = 'ACTIVE' FOR SHARE"
        : "u.deleted_at IS NULL AND u.status = 'ACTIVE' FOR SHARE OF u");
      expect(params).toEqual([actor().id]);
    });

    it.each([
      { name: 'missing or inactive user', rowCount: 0, rows: [] },
      { name: 'incomplete onboarding', rowCount: 1, rows: [{ done: false }] },
    ])('rejects $name with the existing PROFILE_REQUIRED response', async ({ rowCount, rows }) => {
      const mock = createMockDb();
      mock.txQuery.mockResolvedValue({ rowCount, rows });
      await expect(actor().assertOnboarded(mock.txClient)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    });
  });
});
