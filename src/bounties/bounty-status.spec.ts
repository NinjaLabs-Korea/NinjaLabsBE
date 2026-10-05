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

  it('stamps the first-entry timestamp column for tracked transitions only', () => {
    expect(BountyStatusPolicy.stampColumnFor('OPEN')).toBe('opened_at');
    expect(BountyStatusPolicy.stampColumnFor('IN_REVIEW')).toBe('review_started_at');
    expect(BountyStatusPolicy.stampColumnFor('COMPLETED')).toBe('completed_at');
    expect(BountyStatusPolicy.stampColumnFor('SUBMISSION_CLOSED')).toBeUndefined();
  });
});
