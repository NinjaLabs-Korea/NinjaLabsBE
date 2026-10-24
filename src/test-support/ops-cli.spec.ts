import { createPool, extractValueOptions, parseArgs, UUID_RE } from '../../scripts/ops-cli';

/** scripts/ops-cli.js — 운영 스크립트(grant-admin / requeue-nft-jobs) 공용 파서. 실 DB 동작은 src/test-db/ops-scripts.db-spec.ts */
describe('scripts/ops-cli.js', () => {
  it('splits flags from positional arguments', () => {
    expect(parseArgs(['grant', 'a@b.test', '--dry-run', '--yes'], ['dry-run', 'yes'])).toEqual({
      flags: { 'dry-run': true, yes: true },
      positional: ['grant', 'a@b.test'],
    });
  });

  it('throws on an unknown or typoed flag so "--dry-rn" never turns into a real write', () => {
    expect(() => parseArgs(['--dry-rn'], ['dry-run'])).toThrow('unknown option: --dry-rn');
  });

  it('extractValueOptions takes "--name value" pairs out and leaves the rest for parseArgs', () => {
    expect(extractValueOptions(['id', '--reason', 'no wallet', '--dry-run', '--admin', 'u'], ['reason', 'admin'])).toEqual({
      values: { reason: 'no wallet', admin: 'u' },
      rest: ['id', '--dry-run'],
    });
    expect(() => extractValueOptions(['id', '--reason'], ['reason'])).toThrow('option --reason needs a value');
    expect(() => extractValueOptions(['--reason', '--yes'], ['reason'])).toThrow('option --reason needs a value');
    expect(() => extractValueOptions(['--admin', 'a', '--admin', 'b'], ['admin'])).toThrow('option --admin given twice');
  });

  it('requires DATABASE_URL', () => {
    expect(() => createPool({})).toThrow('DATABASE_URL is required');
  });

  it('accepts UUIDs in any case and nothing else', () => {
    expect(UUID_RE.test('5F0C2B9E-1D2A-4C3B-8E4F-0123456789AB')).toBe(true);
    expect(UUID_RE.test('5f0c2b9e1d2a4c3b8e4f0123456789ab')).toBe(false);
  });
});
