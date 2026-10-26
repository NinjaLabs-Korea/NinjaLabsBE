import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { CohortAdminService } from './cohort-admin.service';
import { CohortApplicationAdminService } from './cohort-application-admin.service';
import { CohortApplicationsService } from './cohort-applications.service';
import { withdrawOpenCohortApplicationsOfUser } from './cohort-withdrawal';

const ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const input = {
  displayName: 'A', telegram: '@abcde', twitter: '@a', web3Experience: 'LT_1Y', activityType: 'DEVELOPER', interestAreas: ['KOL'], intro: 'hi',
};

describe('CohortApplicationsService.apply', () => {
  function setup(script: jest.Mock) {
    const { database, db } = createMockDb({ txQuery: script });
    return { db, service: new CohortApplicationsService(database, new AuditService(database)) };
  }

  it('404 COHORT_NOT_FOUND when the cohort is missing or DRAFT', async () => {
    const { service } = setup(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }));
    await expect(service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
  });

  it('409 PROFILE_REQUIRED before COHORT_NOT_ACCEPTING when the profile is not complete', async () => {
    const { service } = setup(jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ accepting: false }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ done: false }] }));
    await expect(service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'PROFILE_REQUIRED' });
  });

  it('409 COHORT_NOT_ACCEPTING when the cohort is not accepting', async () => {
    const { service } = setup(jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ accepting: false }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ done: true }] }));
    await expect(service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
  });

  it('409 COHORT_ALREADY_APPLIED for an existing non-withdrawn application, and for a unique violation race', async () => {
    const accepting = { rowCount: 1, rows: [{ accepting: true }] };
    const done = { rowCount: 1, rows: [{ done: true }] };
    const rejected = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ID, status: 'REJECTED' }] }));
    await expect(rejected.service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });

    const race = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_cohort_application_user' })));
    await expect(race.service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });
  });

  it('400 COHORT_OTHER_DETAIL_REQUIRED before touching the database', async () => {
    const { db, service } = setup(jest.fn());
    await expect(service.apply(ID, USER, { ...input, activityType: 'OTHER' })).rejects.toMatchObject({ message: 'COHORT_OTHER_DETAIL_REQUIRED' });
    expect(db.tx).not.toHaveBeenCalled();
  });
});

describe('CohortApplicationsService.update / withdraw', () => {
  const row = { id: ID, cohort_id: ID, status: 'SUBMITTED', accepting: true, display_name: 'A', telegram: '@abcde', twitter: '@a', web3_experience: 'LT_1Y',
    activity_type: 'DEVELOPER', activity_type_other: null, interest_areas: ['KOL'], interest_other: null, intro: 'hi', cohort_name: 'c', cohort_status: 'OPEN', reviewed_at: null, created_at: new Date(), updated_at: new Date() };
  const make = (script: jest.Mock) => { const { database } = createMockDb({ txQuery: script }); return new CohortApplicationsService(database, new AuditService(database)); };

  it('update: 404 when not the owner, 409 when not SUBMITTED, 409 when the cohort stopped accepting', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: 'ACCEPTED' }] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_SUBMITTED' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, accepting: false }] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
  });

  it('update: merges onto the stored row, so switching to OTHER without detail is rejected', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [row] })).update(ID, USER, { activityType: 'OTHER' })).rejects.toMatchObject({ message: 'COHORT_OTHER_DETAIL_REQUIRED' });
  });

  it('update: does not leak review_note in the applicant view', async () => {
    const script = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ ...row, review_note: 'secret' }] });
    const out = await make(script).update(ID, USER, { intro: 'new' }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('reviewNote');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out).toMatchObject({ editable: true, withdrawable: true });
  });

  it('withdraw: 404 / 409', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).withdraw(ID, USER)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'WITHDRAWN' }] })).withdraw(ID, USER)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_SUBMITTED' });
  });
});

describe('CohortAdminService', () => {
  const make = (script: jest.Mock) => { const { database } = createMockDb({ txQuery: script }); return new CohortAdminService(database, new AuditService(database)); };

  it('create rejects a window that ends before it starts', async () => {
    await expect(make(jest.fn()).create(USER, { name: 'n', opensAt: '2026-11-02T00:00:00Z', closesAt: '2026-11-01T00:00:00Z' })).rejects.toMatchObject({ message: 'COHORT_INVALID_WINDOW' });
  });

  it('transition: 404, invalid (DRAFT->CLOSED), already open', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).transition(ID, 'OPEN', USER)).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'DRAFT' }] })).transition(ID, 'CLOSED', USER)).rejects.toMatchObject({ message: 'COHORT_INVALID_TRANSITION' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'CLOSED' }] }).mockResolvedValueOnce({ rowCount: 1, rows: [{}] })).transition(ID, 'OPEN', USER)).rejects.toMatchObject({ message: 'COHORT_ALREADY_OPEN' });
  });

  it('transition: the single-open index race becomes COHORT_ALREADY_OPEN', async () => {
    const script = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'DRAFT' }] }).mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_cohort_single_open' }));
    await expect(make(script).transition(ID, 'OPEN', USER)).rejects.toMatchObject({ message: 'COHORT_ALREADY_OPEN' });
  });

  it('remove: 409 when the cohort has any application', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rowCount: 1, rows: [{}] })).remove(ID, USER)).rejects.toMatchObject({ message: 'COHORT_HAS_APPLICATIONS' });
  });
});

describe('CohortApplicationAdminService', () => {
  const make = (query: jest.Mock, txQuery: jest.Mock = jest.fn()) => { const { database } = createMockDb({ query, txQuery }); return new CohortApplicationAdminService(database, new AuditService(database)); };

  it('list binds every filter and escapes LIKE metacharacters in q', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValue({ rowCount: 0, rows: [{ n: 0 }] });
    await make(query).list(ID, { status: 'SUBMITTED', activityType: 'KOL', interestArea: 'BIZDEV', q: '50%_\\' }, 2, 10);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id');
    expect(params).toEqual([ID, 'SUBMITTED', 'KOL', 'BIZDEV', '%50\\%\\_\\\\%', 10, 10]);
  });

  it('list: 404 COHORT_NOT_FOUND', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).list(ID, {})).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
  });

  it('review: 404, and 409 COHORT_APPLICATION_WITHDRAWN', async () => {
    await expect(make(jest.fn(), jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).review(ID, 'ACCEPTED', null, USER)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
    await expect(make(jest.fn(), jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'WITHDRAWN' }] })).review(ID, 'REJECTED', null, USER)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_WITHDRAWN' });
  });

  it('review: a changed decision records before/after on the audit row, inside the transaction', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'REJECTED' }] }).mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ID, status: 'ACCEPTED', created_at: new Date(), updated_at: new Date(), interest_areas: [] }] });
    const query = jest.fn();
    await make(query, txQuery).review(ID, 'ACCEPTED', 'ok', USER);
    const audit = txQuery.mock.calls[2];
    expect(audit[0]).toContain('INSERT INTO audit_log');
    expect(audit[1]).toEqual([USER, 'COHORT_APPLICATION_ACCEPTED', 'cohort_application', ID, '{"status":"REJECTED"}', '{"status":"ACCEPTED"}']);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('withdrawOpenCohortApplicationsOfUser', () => {
  it('only touches SUBMITTED rows of that user and never deletes', async () => {
    const tx = { query: jest.fn().mockResolvedValue({}) };
    await withdrawOpenCohortApplicationsOfUser(tx, USER);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain('UPDATE cohort_application');
    expect(sql).not.toMatch(/DELETE/i);
    expect(params).toEqual([USER, 'WITHDRAWN', 'SUBMITTED']);
  });
});
