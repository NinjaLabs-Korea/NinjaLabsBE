import { BountyStatusPolicy } from './bounty-status';

describe('BountyStatusPolicy', () => {
  it.each([
    ['DRAFT', 'OPEN', true],
    ['FUNDING_PENDING', 'OPEN', true],
    ['OPEN', 'SUBMISSION_CLOSED', true],
    ['SUBMISSION_CLOSED', 'IN_REVIEW', true],
    ['IN_REVIEW', 'COMPLETED', true],
    ['OPEN', 'COMPLETED', false],
    ['COMPLETED', 'OPEN', false],
    ['CANCELLED', 'OPEN', false],
    ['UNKNOWN', 'OPEN', false],
  ])('canTransition(%s -> %s) = %s', (from, to, expected) => {
    expect(BountyStatusPolicy.canTransition(from, to)).toBe(expected);
  });

  it('treats only OPEN, SUBMISSION_CLOSED and IN_REVIEW as in progress', () => {
    expect(['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']
      .filter(BountyStatusPolicy.isInProgress)).toEqual(['OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW']);
  });

  it('enforces a future deadline only while the bounty is still taking intake (DRAFT, FUNDING_PENDING, OPEN)', () => {
    expect(['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']
      .filter(BountyStatusPolicy.enforcesFutureDeadline)).toEqual(['DRAFT', 'FUNDING_PENDING', 'OPEN']);
  });

  it('stamps the first-entry timestamp column for tracked transitions only', () => {
    expect(BountyStatusPolicy.stampColumnFor('OPEN')).toBe('opened_at');
    expect(BountyStatusPolicy.stampColumnFor('IN_REVIEW')).toBe('review_started_at');
    expect(BountyStatusPolicy.stampColumnFor('COMPLETED')).toBe('completed_at');
    expect(BountyStatusPolicy.stampColumnFor('SUBMISSION_CLOSED')).toBeUndefined();
  });
});

describe('BountyStatusPolicy transition table (every from × to pair)', () => {
  const ALL = ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'] as const;
  /** The operator transitions the admin UI offers (docs/decisions.md, wiki be/bounties 전이표) — anything not listed must be refused */
  const ALLOWED: Record<string, string[]> = {
    DRAFT: ['FUNDING_PENDING', 'OPEN', 'CANCELLED'],
    FUNDING_PENDING: ['OPEN', 'CANCELLED'],
    OPEN: ['SUBMISSION_CLOSED', 'CANCELLED'],
    SUBMISSION_CLOSED: ['IN_REVIEW', 'OPEN'],
    IN_REVIEW: ['COMPLETED', 'OPEN'],
    COMPLETED: [],
    CANCELLED: [],
  };
  const pairs = ALL.flatMap((from) => ALL.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

  it.each(pairs)('%s -> %s allowed=%s', (from, to, allowed) => {
    expect(BountyStatusPolicy.canTransition(from, to)).toBe(allowed);
  });

  it('never allows a self-transition or leaving a finished state', () => {
    for (const s of ALL) expect(BountyStatusPolicy.canTransition(s, s)).toBe(false);
    for (const to of ALL) {
      expect(BountyStatusPolicy.canTransition('COMPLETED', to)).toBe(false);
      expect(BountyStatusPolicy.canTransition('CANCELLED', to)).toBe(false);
    }
  });

  it('a bounty in progress can no longer be cancelled once intake closed (SUBMISSION_CLOSED / IN_REVIEW → CANCELLED refused)', () => {
    expect(BountyStatusPolicy.canTransition('SUBMISSION_CLOSED', 'CANCELLED')).toBe(false);
    expect(BountyStatusPolicy.canTransition('IN_REVIEW', 'CANCELLED')).toBe(false);
  });

  it('treats exactly COMPLETED and CANCELLED as finished (no more reviews)', () => {
    expect(ALL.filter(BountyStatusPolicy.isFinished)).toEqual(['COMPLETED', 'CANCELLED']);
    expect(BountyStatusPolicy.isFinished('UNKNOWN')).toBe(false);
    expect(BountyStatusPolicy.isInProgress('UNKNOWN')).toBe(false);
  });

  it('stamps nothing for CANCELLED, DRAFT or FUNDING_PENDING', () => {
    for (const s of ['CANCELLED', 'DRAFT', 'FUNDING_PENDING']) expect(BountyStatusPolicy.stampColumnFor(s)).toBeUndefined();
  });
});
