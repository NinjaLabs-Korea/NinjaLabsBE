import { createMockDb } from './mock-db';

describe('createMockDb strict mode', () => {
  it('throws "Unexpected SQL" with the first 80 characters for a statement no handler matches', async () => {
    const { db } = createMockDb({ strict: true, handlers: [{ match: /^SELECT 1/, reply: () => ({ rowCount: 1, rows: [{ n: 1 }] }) }] });
    const long = `UPDATE   some_table\n   SET a = 1 ${'x'.repeat(200)}`;
    await expect(db.query(long)).rejects.toThrow(`Unexpected SQL: ${long.replace(/\s+/g, ' ').slice(0, 80)}`);
    await expect(db.query(long)).rejects.toThrow(/^Unexpected SQL: .{0,80}$/s);
  });

  it('also rejects unknown SQL on the transaction path', async () => {
    const { database } = createMockDb({ strict: true });
    await expect(database.tx((tx) => tx.query('DELETE FROM nope'))).rejects.toThrow('Unexpected SQL: DELETE FROM nope');
  });

  it('matches handlers against whitespace-collapsed SQL, so whitespace-only rewording still routes', async () => {
    const { db } = createMockDb({ strict: true, handlers: [{ match: /^UPDATE t SET a = 1 WHERE id = \$1$/, reply: () => ({ rowCount: 1, rows: [] }) }] });
    await expect(db.query('UPDATE t\n      SET a = 1\n    WHERE   id = $1', ['x'])).resolves.toEqual({ rowCount: 1, rows: [] });
  });

  it('gives the reply the params, uses the first matching handler, and lets handle() override in front', async () => {
    const mock = createMockDb({ strict: true, handlers: [{ match: /FROM t/, reply: (params) => ({ rowCount: 1, rows: [{ id: params?.[0] }] }) }] });
    await expect(mock.db.query('SELECT id FROM t WHERE id = $1', [7])).resolves.toEqual({ rowCount: 1, rows: [{ id: 7 }] });
    mock.handle(/FROM t/, () => ({ rowCount: 0, rows: [] }));
    await expect(mock.db.query('SELECT id FROM t WHERE id = $1', [7])).resolves.toEqual({ rowCount: 0, rows: [] });
  });

  it('statements() returns matching pool statements in call order with normalized SQL', async () => {
    const mock = createMockDb({ strict: true, handlers: [{ match: /.*/, reply: () => ({ rowCount: 1, rows: [] }) }] });
    await mock.db.query('UPDATE a\n SET x = $1', [1]);
    await mock.db.query('SELECT 1');
    await mock.db.query('UPDATE a SET x = $1', [2]);
    expect(mock.statements(/^UPDATE a/)).toEqual([
      { sql: 'UPDATE a SET x = $1', params: [1] },
      { sql: 'UPDATE a SET x = $1', params: [2] },
    ]);
  });

  it('keeps the SQL/params placeholder check in strict mode', async () => {
    const { db } = createMockDb({ strict: true, handlers: [{ match: /.*/, reply: () => ({ rowCount: 1, rows: [] }) }] });
    expect(() => db.query('SELECT $1, $2', [1])).toThrow(/binds 1 parameter/);
  });

  it('default (non-strict) mode is unchanged: an unscripted jest.fn returns undefined without throwing', async () => {
    const { db } = createMockDb();
    expect(db.query('anything')).toBeUndefined();
  });
});
