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
