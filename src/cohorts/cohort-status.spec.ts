import { readFileSync } from 'fs';
import { join } from 'path';
import { statusCheckValues } from '../test-support/migration-check';
import { ACTIVITY_TYPES, CohortApplicationPolicy, CohortStatusPolicy, INTEREST_AREAS, WEB3_EXPERIENCES, cohortAcceptingSql } from './cohort-status';

const MIGRATION = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0018_cohort_recruitment.sql'), 'utf8');
const inList = (column: string) => {
  const m = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(MIGRATION);
  if (!m) throw new Error(`no ${column} IN (...) in 0018`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('cohort value sets match the 0018 CHECK constraints', () => {
  it('cohort.status and cohort_application.status', () => {
    expect(CohortStatusPolicy.all().sort()).toEqual(statusCheckValues('cohort').sort());
    expect(CohortApplicationPolicy.all().sort()).toEqual(statusCheckValues('cohort_application').sort());
  });
  it('experience, activity type and interest areas', () => {
    expect([...WEB3_EXPERIENCES].sort()).toEqual(inList('web3_experience').sort());
    expect([...ACTIVITY_TYPES].sort()).toEqual(inList('activity_type').sort());
    const interest = /interest_areas <@ ARRAY\[([^\]]*)\]/.exec(MIGRATION)![1];
    expect([...INTEREST_AREAS].sort()).toEqual([...interest.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
  });
  it('interest areas are the activity types minus STUDENT', () => {
    expect([...INTEREST_AREAS]).toEqual(ACTIVITY_TYPES.filter((a) => a !== 'STUDENT'));
  });
});

describe('CohortStatusPolicy', () => {
  it('allows DRAFT->OPEN, OPEN->CLOSED and the reopen CLOSED->OPEN only', () => {
    const all = CohortStatusPolicy.all();
    const allowed = all.flatMap((from) => all.filter((to) => CohortStatusPolicy.canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(allowed.sort()).toEqual(['CLOSED->OPEN', 'DRAFT->OPEN', 'OPEN->CLOSED']);
    expect(CohortStatusPolicy.allowedTransitions('DRAFT')).toEqual(['OPEN']);
    expect(CohortStatusPolicy.allowedTransitions('nope')).toEqual([]);
    expect(CohortStatusPolicy.transitionTargets()).toEqual(['OPEN', 'CLOSED']);
  });
});

describe('CohortApplicationPolicy', () => {
  const all = CohortApplicationPolicy.all();
  it('only SUBMITTED is editable/withdrawable; only WITHDRAWN can reapply; everything but WITHDRAWN is reviewable', () => {
    expect(all.filter(CohortApplicationPolicy.isEditable)).toEqual(['SUBMITTED']);
    expect(all.filter(CohortApplicationPolicy.canReapply)).toEqual(['WITHDRAWN']);
    expect(all.filter(CohortApplicationPolicy.isReviewable)).toEqual(['SUBMITTED', 'ACCEPTED', 'REJECTED']);
    expect(CohortApplicationPolicy.reviewDecisions()).toEqual(['ACCEPTED', 'REJECTED']);
  });
});

describe('cohortAcceptingSql', () => {
  it('is OPEN and inside [opens_at, closes_at] with open ends, for the given alias', () => {
    expect(cohortAcceptingSql('x')).toContain("x.status = 'OPEN'");
    expect(cohortAcceptingSql('x')).toContain('x.opens_at <= now()');
    expect(cohortAcceptingSql('x')).toContain('x.closes_at >= now()');
  });
});
