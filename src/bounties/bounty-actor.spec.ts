import { BountyActor } from './bounty-actor';

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
});
