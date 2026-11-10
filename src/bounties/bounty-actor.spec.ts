import { BountyActor } from './bounty-actor';
import { createMockDb, normalizeSql } from '../test-support/mock-db';
import { activeUserSql } from '../users/active-user';

describe('BountyActor', () => {
  it('exposes the user id', () => {
    expect(BountyActor.user('u1').id).toBe('u1');
  });

  it('records the audit row with the user as actor', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const runner = {} as never;
    await BountyActor.user('u1').recordAudit(audit as never, 'APPLICATION_SUBMITTED', 'bounty_application', 'a1', runner, { after: { status: 'PENDING' } } as never);
    expect(audit.record).toHaveBeenCalledWith('u1', 'APPLICATION_SUBMITTED', 'bounty_application', 'a1', runner, { after: { status: 'PENDING' } });
  });

  describe('eligibility', () => {
    it('checks active onboarding and locks only the user in the supplied transaction', async () => {
      const mock = createMockDb();
      mock.txQuery.mockResolvedValue({ rowCount: 1, rows: [{ done: true }] });
      await expect(BountyActor.user('u').assertOnboarded(mock.txClient)).resolves.toBeUndefined();
      expect(mock.query).not.toHaveBeenCalled();
      expect(mock.txQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mock.txQuery.mock.calls[0];
      expect(normalizeSql(sql)).toContain(`${activeUserSql('')} FOR SHARE`);
      expect(params).toEqual(['u']);
    });

    it.each([
      { name: 'missing or inactive user', rowCount: 0, rows: [] },
      { name: 'incomplete onboarding', rowCount: 1, rows: [{ done: false }] },
    ])('rejects $name with the existing PROFILE_REQUIRED response', async ({ rowCount, rows }) => {
      const mock = createMockDb();
      mock.txQuery.mockResolvedValue({ rowCount, rows });
      await expect(BountyActor.user('u').assertOnboarded(mock.txClient)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    });
  });
});
