import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { CohortAdminService } from './cohort-admin.service';
import { CohortApplicationAdminService } from './cohort-application-admin.service';
import { CohortApplicationsService } from './cohort-applications.service';
import { DEFAULT_COHORT_QUESTIONS } from './cohort-questions';
import { withdrawOpenCohortApplicationsOfUser } from './cohort-withdrawal';

const ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const input = {
  displayName: 'A', telegram: '@abcde', twitter: '@a', intro: 'hi',
  answers: [{ questionId: 'web3_experience', choices: ['LT_1Y'] }, { questionId: 'interest_areas', choices: ['KOL'] }],
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
    const accepting = { rowCount: 1, rows: [{ accepting: true, questions: DEFAULT_COHORT_QUESTIONS }] };
    const done = { rowCount: 1, rows: [{ done: true }] };
    const rejected = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ID, status: 'REJECTED' }] }));
    await expect(rejected.service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });

    const race = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_cohort_application_user' })));
    await expect(race.service.apply(ID, USER, input)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });
  });

  describe('answers body', () => {
    const fixed = { displayName: 'A', telegram: '@abcde', twitter: '@a', intro: 'hi' };
    const answers = input.answers;
    const accepting = { rowCount: 1, rows: [{ accepting: true, questions: DEFAULT_COHORT_QUESTIONS }] };
    const done = { rowCount: 1, rows: [{ done: true }] };

    it(' validates against the locked cohort questions and writes NULL legacy columns plus the snapshot', async () => {
      const script = jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ID }] }).mockResolvedValue({ rowCount: 1, rows: [{ id: ID, answers: [] }] });
      const { service } = setup(script);
      await service.apply(ID, USER, { ...fixed, answers });
      const insert = script.mock.calls.find(([sql]) => /INSERT INTO cohort_application/.test(sql))!;
      const params = insert[1] as unknown[];
      expect(params.slice(2, 6)).toEqual(['A', '@abcde', '@a', 'hi']);
      expect(params.slice(6, 11)).toEqual([null, null, null, null, null]);
      expect(JSON.parse(params[11] as string).map((a: { questionId: string }) => a.questionId)).toEqual(['web3_experience', 'interest_areas']);
    });

    it('a required question left out is 400 COHORT_ANSWERS_INVALID', async () => {
      const { service } = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done));
      await expect(service.apply(ID, USER, { ...fixed, answers: [answers[0]] })).rejects.toMatchObject({ message: 'COHORT_ANSWERS_INVALID' });
    });

    it('re-opening a WITHDRAWN application writes the new shape (NULL legacy columns), even over a legacy-shape row', async () => {
      const script = jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ID, status: 'WITHDRAWN' }] })
        .mockResolvedValue({ rowCount: 1, rows: [{ id: ID, answers: [] }] });
      const { service } = setup(script);
      await service.apply(ID, USER, { ...fixed, answers });
      const params = script.mock.calls.find(([sql]) => /UPDATE cohort_application/.test(sql))![1] as unknown[];
      expect(params.slice(6, 11)).toEqual([null, null, null, null, null]);
      expect(JSON.parse(params[11] as string)).toHaveLength(2);
    });

    it('400 COHORT_OTHER_DETAIL_REQUIRED when the withDetail option is chosen without other', async () => {
      const { service } = setup(jest.fn().mockResolvedValueOnce(accepting).mockResolvedValueOnce(done));
      await expect(service.apply(ID, USER, { ...fixed, answers: [answers[0], { questionId: 'interest_areas', choices: ['OTHER'] }] }))
        .rejects.toMatchObject({ message: 'COHORT_OTHER_DETAIL_REQUIRED' });
    });
  });
});

describe('CohortApplicationsService.update / withdraw', () => {
  const row = { id: ID, cohort_id: ID, status: 'SUBMITTED', accepting: true, display_name: 'A', telegram: '@abcde', twitter: '@a', web3_experience: 'LT_1Y',
    activity_type: 'DEVELOPER', activity_type_other: null, interest_areas: ['KOL'], interest_other: null, answers: [], questions: DEFAULT_COHORT_QUESTIONS, intro: 'hi', cohort_name: 'c', cohort_status: 'OPEN', reviewed_at: null, created_at: new Date(), updated_at: new Date() };
  const make = (script: jest.Mock) => { const { database } = createMockDb({ txQuery: script }); return new CohortApplicationsService(database, new AuditService(database)); };

  it('update: 404 when not the owner, 409 when not SUBMITTED, 409 when the cohort stopped accepting', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: 'ACCEPTED' }] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_SUBMITTED' });
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, accepting: false }] })).update(ID, USER, {})).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
  });

  it('update: a fixed-only patch on a stored legacy-shape row rewrites its legacy columns unchanged (answers stay [])', async () => {
    const legacyRow = { ...row, activity_type: 'OTHER', activity_type_other: 'farmer', interest_areas: ['KOL', 'OTHER'], interest_other: 'art' };
    const script = jest.fn().mockResolvedValue({ rowCount: 1, rows: [legacyRow] });
    await make(script).update(ID, USER, { displayName: 'B' });
    const write = script.mock.calls.find(([sql]) => /UPDATE cohort_application/.test(sql))![1] as unknown[];
    expect(write.slice(1, 11)).toEqual(['B', '@abcde', '@a', 'hi', 'LT_1Y', 'OTHER', 'farmer', ['KOL', 'OTHER'], 'art', '[]']);
  });

  it('update: answers replace everything against the current questions and null the legacy columns; fixed-only patches keep stored answers', async () => {
    const script = jest.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    await make(script).update(ID, USER, { answers: [{ questionId: 'web3_experience', choices: ['GT_3Y'] }, { questionId: 'interest_areas', choices: ['KOL'] }] });
    const write = script.mock.calls.find(([sql]) => /UPDATE cohort_application/.test(sql))![1] as unknown[];
    expect(write.slice(5, 10)).toEqual([null, null, null, null, null]);
    expect(JSON.parse(write[10] as string)).toHaveLength(2);

    const newRow = { ...row, web3_experience: null, activity_type: null, interest_areas: null, answers: [{ questionId: 'old_question' }] };
    const keep = jest.fn().mockResolvedValue({ rowCount: 1, rows: [newRow] });
    await make(keep).update(ID, USER, { intro: 'changed' });
    const kept = keep.mock.calls.find(([sql]) => /UPDATE cohort_application/.test(sql))![1] as unknown[];
    expect(kept[4]).toBe('changed');
    expect(JSON.parse(kept[10] as string)).toEqual([{ questionId: 'old_question' }]); // not re-checked against the edited form
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

  it('putQuestions: 404 for a missing cohort, 400 COHORT_QUESTIONS_INVALID for an unknown id', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] })).putQuestions(ID, USER, [])).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
    const stored = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ questions: DEFAULT_COHORT_QUESTIONS }] });
    await expect(make(stored).putQuestions(ID, USER, [{ id: 'ghost', type: 'SHORT_TEXT', label: { ko: 'x' }, required: false }])).rejects.toMatchObject({ message: 'COHORT_QUESTIONS_INVALID' });
  });

  it('remove: 409 when the cohort has any application', async () => {
    await expect(make(jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rowCount: 1, rows: [{}] })).remove(ID, USER)).rejects.toMatchObject({ message: 'COHORT_HAS_APPLICATIONS' });
  });
});

describe('CohortApplicationAdminService', () => {
  const make = (query: jest.Mock, txQuery: jest.Mock = jest.fn()) => { const { database } = createMockDb({ query, txQuery }); return new CohortApplicationAdminService(database, new AuditService(database)); };

  it('list binds every filter and escapes LIKE metacharacters in q', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValue({ rowCount: 0, rows: [{ n: 0 }] });
    await make(query).list(ID, { status: 'SUBMITTED', questionId: 'web3_experience', optionId: 'Y1_3', activityType: 'KOL', interestArea: 'BIZDEV', q: '50%_\\' }, 2, 10);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id');
    expect(sql).toContain("jsonb_build_object('questionId'");
    // questionId+optionId first, then the old aliases (interestArea == interest_areas, activityType == activity_type)
    expect(params).toEqual([ID, 'SUBMITTED', 'web3_experience', 'Y1_3', 'interest_areas', 'BIZDEV', 'activity_type', 'KOL', '%50\\%\\_\\\\%', 10, 10]);
  });

  it('list ignores a lone questionId or optionId (the filter needs both)', async () => {
    for (const filter of [{ questionId: 'interest_areas' }, { optionId: 'KOL' }]) {
      const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValue({ rowCount: 0, rows: [{ n: 0 }] });
      await make(query).list(ID, filter, 1, 10);
      expect(query.mock.calls[1][1]).toEqual([ID, 10, 0]);
    }
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
