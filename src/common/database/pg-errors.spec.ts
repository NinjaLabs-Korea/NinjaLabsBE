import { BadRequestException } from '@nestjs/common';
import { asClientError, isForeignKeyViolation, isUniqueViolation } from './pg-errors';

const pgError = (fields: Record<string, string>) => Object.assign(new Error('pg'), fields);

describe('pg-errors', () => {
  it('isUniqueViolation narrows to one constraint when given a name', () => {
    const nickname = pgError({ code: '23505', constraint: 'uq_user_nickname_active' });
    const tag = pgError({ code: '23505', constraint: 'user_tag_pkey' });
    expect(isUniqueViolation(nickname)).toBe(true);
    expect(isUniqueViolation(nickname, 'uq_user_nickname_active')).toBe(true);
    expect(isUniqueViolation(tag, 'uq_user_nickname_active')).toBe(false);
    expect(isUniqueViolation(pgError({ code: '23503' }))).toBe(false);
  });

  it('isForeignKeyViolation narrows to one constraint when given a name', () => {
    const fk = pgError({ code: '23503', constraint: 'fk_highlight_bounty' });
    expect(isForeignKeyViolation(fk, 'fk_highlight_bounty')).toBe(true);
    expect(isForeignKeyViolation(fk, 'other_fk')).toBe(false);
  });

  it('maps a FK violation that points at a missing row to 400 REFERENCE_NOT_FOUND', () => {
    const mapped = asClientError(pgError({ code: '23503', detail: 'Key (bounty_id)=(…) is not present in table "bounty".' }));
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as BadRequestException).message).toBe('REFERENCE_NOT_FOUND');
  });

  it('leaves a FK violation from deleting a still-referenced row untouched (not the client\'s value)', () => {
    const referenced = pgError({ code: '23503', detail: 'Key (id)=(…) is still referenced from table "bounty".' });
    expect(asClientError(referenced)).toBe(referenced);
  });
});

describe('asClientError — only request-caused Postgres errors become 400', () => {
  it.each([
    ['22021 NUL byte', { code: '22021' }, 'INVALID_CHARACTER'],
    ['22P05 untranslatable', { code: '22P05' }, 'INVALID_CHARACTER'],
    ['23503 missing reference', { code: '23503', detail: 'Key (bounty_id)=(00000000-0000-0000-0000-000000000000) is not present in table "bounty".' }, 'REFERENCE_NOT_FOUND'],
  ])('%s → 400 %s', (_label, fields, message) => {
    const mapped = asClientError(Object.assign(new Error('pg'), fields));
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as BadRequestException).getStatus()).toBe(400);
    expect((mapped as BadRequestException).message).toBe(message);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '22021'],
    ['a number', 22021],
    ['numeric code', { code: 22021 }],
    ['23503 without detail', { code: '23503' }],
    ['23503 with a non-string detail', { code: '23503', detail: { text: 'is not present in table' } }],
    ['23503 still referenced', { code: '23503', detail: 'Key (id)=(x) is still referenced from table "nft".' }],
    ['23505 unique', { code: '23505' }],
    ['22001 too long (validation should have caught it — a server bug, stays 500)', { code: '22001' }],
    ['22003 out of range', { code: '22003' }],
    ['an HttpException', new BadRequestException('X')],
  ])('%s passes through unchanged', (_label, err) => {
    expect(asClientError(err)).toBe(err);
  });
});
