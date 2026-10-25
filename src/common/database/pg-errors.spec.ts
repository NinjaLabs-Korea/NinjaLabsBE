import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { asClientError, asHttpError, isDatabaseUnavailable, isForeignKeyViolation, isUniqueViolation } from './pg-errors';

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
    ['22008 date out of range (2026-02-31)', { code: '22008' }, 'INVALID_DATE'],
    ['22007 invalid datetime format', { code: '22007' }, 'INVALID_DATE'],
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

describe('asHttpError — DB connection/response timeouts become 503 DATABASE_UNAVAILABLE', () => {
  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
    'Query read timeout',
  ])('%s → 503', (message) => {
    const err = new Error(message);
    expect(isDatabaseUnavailable(err)).toBe(true);
    const mapped = asHttpError(err) as ServiceUnavailableException;
    expect(mapped).toBeInstanceOf(ServiceUnavailableException);
    expect(mapped.getResponse()).toMatchObject({ statusCode: 503, message: 'DATABASE_UNAVAILABLE' });
  });

  it.each([
    ['a dropped connection mid-query (DB restart / failover)', new Error('Connection terminated unexpectedly')],
    ['ECONNREFUSED while connecting', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
    ['ENOTFOUND (DNS)', Object.assign(new Error('getaddrinfo ENOTFOUND db.example'), { code: 'ENOTFOUND' })],
    ['57P01 admin_shutdown (Supabase restart)', pgError({ code: '57P01' })],
    ['57P03 cannot_connect_now (database starting up)', pgError({ code: '57P03' })],
    ['53300 too_many_connections', pgError({ code: '53300' })],
    ['08006 connection_failure', pgError({ code: '08006' })],
  ])('%s → 503', (_label, err) => {
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect(asHttpError(err)).toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not treat a client-side socket reset or other SQLSTATEs as a database outage', () => {
    for (const err of [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), // a browser abandoning an upload — not ours to blame on the DB
      pgError({ code: '40P01' }), // deadlock_detected stays a 500
      pgError({ code: '23505' }),
    ]) {
      expect(isDatabaseUnavailable(err)).toBe(false);
      expect(asHttpError(err)).toBe(err);
    }
  });

  it('leaves a server-side statement timeout (57014) and other errors as they are, and still applies the 400 mapping', () => {
    const canceled = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    expect(asHttpError(canceled)).toBe(canceled);
    expect(isDatabaseUnavailable('timeout exceeded when trying to connect')).toBe(false); // only Error instances
    expect(asHttpError(pgError({ code: '22021' }))).toBeInstanceOf(BadRequestException);
  });
});
