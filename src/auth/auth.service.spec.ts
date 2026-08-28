import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { AuthService } from './auth.service';

describe('AuthService refresh rotation', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function createService(
    txQuery: jest.Mock,
    signAsync: jest.Mock = jest.fn(async () => 'next-access-token'),
  ) {
    const db = {
      query: jest.fn(),
      tx: jest.fn(
        async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
          callback({ query: txQuery }),
      ),
    };
    const jwt = { signAsync };
    const service = new AuthService(
      db as unknown as DatabaseService,
      jwt as never,
      { get: jest.fn() } as never,
    );
    return { db, jwt, service };
  }

  it('revokes the old token and inserts its replacement in one transaction', async () => {
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_id: userId, is_admin: true }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { db, jwt, service } = createService(txQuery);

    const result = await service.refresh('old-refresh-token', '127.0.0.1', 'jest');

    expect(result.accessToken).toBe('next-access-token');
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: userId, adm: true });

    const consumeCall = txQuery.mock.calls[0];
    expect(consumeCall[0]).toContain('UPDATE auth_session AS s');
    expect(consumeCall[0]).toContain('s.revoked_at IS NULL');
    expect(consumeCall[0]).toContain('RETURNING s.user_id, u.is_admin');
    expect(consumeCall[1]).toEqual([
      createHash('sha256').update('old-refresh-token').digest('hex'),
    ]);

    const insertCall = txQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO auth_session');
    expect(insertCall[1]).toEqual([
      userId,
      createHash('sha256').update(result.refreshToken).digest('hex'),
      '127.0.0.1',
      'jest',
    ]);
  });

  it('rejects an expired or already consumed refresh token without issuing a replacement', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const { jwt, service } = createService(txQuery);

    await expect(service.refresh('already-used')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('allows only one of two concurrent rotations using the same token', async () => {
    let consumed = false;
    const txQuery = jest.fn(async (sql: string) => {
      if (sql.includes('UPDATE auth_session AS s')) {
        if (consumed) return { rowCount: 0, rows: [] };
        consumed = true;
        await Promise.resolve();
        return {
          rowCount: 1,
          rows: [{ user_id: userId, is_admin: false }],
        };
      }
      if (sql.includes('INSERT INTO auth_session')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const { jwt, service } = createService(txQuery);

    const results = await Promise.allSettled([
      service.refresh('shared-refresh-token'),
      service.refresh('shared-refresh-token'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(jwt.signAsync).toHaveBeenCalledTimes(1);
    expect(
      txQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO auth_session')),
    ).toHaveLength(1);
  });
});
