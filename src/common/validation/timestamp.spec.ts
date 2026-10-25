import { validate } from 'class-validator';
import { UpdateBountyDto } from '../../bounties/admin/bounty-admin.dto';
import { plainToInstance } from 'class-transformer';

describe('IsTimestampString', () => {
  const check = async (submissionDeadline: unknown) =>
    (await validate(plainToInstance(UpdateBountyDto, { submissionDeadline }))).length === 0;

  it('rejects year 0000, which Postgres cannot store (22008 → 500)', async () => {
    expect(await check('0000-01-01T00:00:00Z')).toBe(false);
    expect(await check('0000-12-31T23:59:59+09:00')).toBe(false);
  });

  it('accepts ordinary and far-future ISO timestamps, rejects non-ISO', async () => {
    expect(await check('2026-12-31T23:59:59Z')).toBe(true);
    expect(await check('0001-01-01T00:00:00Z')).toBe(true);
    expect(await check('9999-12-31T23:59:59Z')).toBe(true);
    expect(await check('tomorrow')).toBe(false);
    expect(await check(20260101)).toBe(false);
  });
});
