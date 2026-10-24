import { FORFEITABLE_BOUNTY_STATUSES, ForfeitAdminRow, ForfeitSubmissionRow, normalizeReason, REASON_MAX, refusalReason, reviewComment } from '../../scripts/forfeit-award';
import { BountyStatusPolicy } from '../bounties/bounty-status';

/** scripts/forfeit-award.js의 순수 함수 — 실 DB 동작(잠금, 한 트랜잭션, 감사 행)은 src/test-db/ops-scripts.db-spec.ts */
describe('scripts/forfeit-award.js (pure helpers)', () => {
  const admin: ForfeitAdminRow = { id: 'a', is_admin: true, status: 'ACTIVE', deleted: false };
  const submission: ForfeitSubmissionRow = {
    id: 's', bounty_id: 'b', submission_status: 'APPROVED', current_revision_no: 1,
    bounty_status: 'IN_REVIEW', bounty_deleted: false, payouts: 0, nfts: 0,
  };

  it('accepts exactly the bounty statuses submission review accepts (bounty-status.ts IN_PROGRESS)', () => {
    expect([...FORFEITABLE_BOUNTY_STATUSES].sort()).toEqual(BountyStatusPolicy.inProgressStatuses().sort());
  });

  it('normalizes the reason: trimmed, 1..500 characters, strings only', () => {
    expect(normalizeReason('  no wallet after 30 days  ')).toBe('no wallet after 30 days');
    expect(normalizeReason('   ')).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason('x'.repeat(REASON_MAX))).toHaveLength(REASON_MAX);
    expect(normalizeReason('x'.repeat(REASON_MAX + 1))).toBeNull();
    expect(reviewComment('no wallet')).toBe('forfeited: no wallet');
  });

  it('passes an approved, payout-less award on an in-progress bounty with an active admin', () => {
    for (const status of FORFEITABLE_BOUNTY_STATUSES) expect(refusalReason({ ...submission, bounty_status: status }, admin)).toBeNull();
  });

  it.each([
    ['unknown admin', submission, null, 'not an active admin'],
    ['non-admin', submission, { ...admin, is_admin: false }, 'not an active admin'],
    ['suspended admin', submission, { ...admin, status: 'SUSPENDED' }, 'not an active admin'],
    ['withdrawn admin', submission, { ...admin, deleted: true }, 'not an active admin'],
    ['missing submission', null, admin, 'submission not found'],
    ['deleted bounty', { ...submission, bounty_deleted: true }, admin, 'bounty is deleted'],
    ['COMPLETED bounty', { ...submission, bounty_status: 'COMPLETED' }, admin, 'bounty is COMPLETED'],
    ['CANCELLED bounty', { ...submission, bounty_status: 'CANCELLED' }, admin, 'bounty is CANCELLED'],
    ['REJECTED submission', { ...submission, submission_status: 'REJECTED' }, admin, 'not APPROVED'],
    ['payout row', { ...submission, payouts: 1 }, admin, 'runbook.md §7.4'],
    ['completion NFT', { ...submission, nfts: 1 }, admin, 'completion NFT'],
  ] as const)('refuses: %s', (_label, sub, adm, message) => {
    expect(refusalReason(sub as ForfeitSubmissionRow | null, adm as ForfeitAdminRow | null)).toContain(message);
  });
});
