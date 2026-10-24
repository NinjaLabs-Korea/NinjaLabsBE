import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { attachPoolErrorHandler, DatabaseService, runInTransaction } from './database.service';

describe('attachPoolErrorHandler', () => {
  it('turns an idle-client error into a log line instead of an uncaught error event', () => {
    const pool = new EventEmitter();
    const logger = { error: jest.fn() };
    attachPoolErrorHandler(pool as never, logger);

    // Without a listener EventEmitter#emit('error') throws (that is what kills the process).
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('terminating connection'));
  });
});

describe('runInTransaction', () => {
  const logger = () => ({ error: jest.fn() });

  it('commits and releases the client normally', async () => {
    const client = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    await expect(runInTransaction(client, async () => 'ok', logger())).resolves.toBe('ok');
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back, rethrows the original error and returns a healthy client to the pool', async () => {
    const client = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    const original = new Error('CONFLICT');
    await expect(runInTransaction(client, async () => { throw original; }, logger())).rejects.toBe(original);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('keeps the original error when ROLLBACK fails and discards the broken client', async () => {
    const connectionLost = new Error('Connection terminated unexpectedly');
    const client = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql === 'ROLLBACK') throw connectionLost;
        return {};
      }),
      release: jest.fn(),
    };
    const original = new Error('write failed');
    const log = logger();

    await expect(runInTransaction(client, async () => { throw original; }, log)).rejects.toBe(original);
    expect(client.release).toHaveBeenCalledWith(connectionLost);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK failed'));
  });
});

describe('runInTransaction — failures outside the callback', () => {
  const logger = () => ({ error: jest.fn() });

  it('BEGIN failing (dead connection) never runs the callback, rethrows the BEGIN error and discards the client', async () => {
    const dead = new Error('Connection terminated');
    const client = { query: jest.fn().mockRejectedValue(dead), release: jest.fn() };
    const fn = jest.fn();
    await expect(runInTransaction(client, fn, logger())).rejects.toBe(dead);
    expect(fn).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(dead); // ROLLBACK failed too → never hand the socket back to the pool
  });

  it('COMMIT failing (e.g. a deferred constraint, 40001) rolls back and surfaces the COMMIT error, not the callback result', async () => {
    const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const client = {
      query: jest.fn().mockImplementation(async (sql: string) => { if (sql === 'COMMIT') throw serialization; return {}; }),
      release: jest.fn(),
    };
    await expect(runInTransaction(client, async () => 'written', logger())).rejects.toBe(serialization);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('releases exactly once on every path', async () => {
    for (const fail of [undefined, 'BEGIN', 'COMMIT', 'ROLLBACK']) {
      const client = {
        query: jest.fn().mockImplementation(async (sql: string) => { if (sql === fail) throw new Error(sql); return {}; }),
        release: jest.fn(),
      };
      await runInTransaction(client, async () => { if (fail === 'ROLLBACK') throw new Error('fn'); }, logger()).catch(() => undefined);
      expect({ fail, releases: client.release.mock.calls.length }).toEqual({ fail, releases: 1 });
    }
  });

  it('passes the same client to the callback, so its statements run inside the transaction', async () => {
    const client = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    await runInTransaction(client, async (tx) => { await tx.query('UPDATE x SET y = 1'); }, logger());
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'UPDATE x SET y = 1', 'COMMIT']);
  });
});

describe('DatabaseService', () => {
  const config = (values: Record<string, string | undefined>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [{ NODE_ENV: 'production', PGSSLMODE: undefined, DATABASE_CA_CERT: undefined }, true],
    [{ NODE_ENV: 'production', PGSSLMODE: 'require', DATABASE_CA_CERT: '   ' }, true],
    [{ NODE_ENV: 'production', PGSSLMODE: 'require', DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----' }, false],
    [{ NODE_ENV: 'production', PGSSLMODE: 'disable', DATABASE_CA_CERT: undefined }, false],
    [{ NODE_ENV: 'development', PGSSLMODE: undefined, DATABASE_CA_CERT: undefined }, false],
  ])('warns about unverified TLS only in production without a CA: %p → %p', async (env, warned) => {
    const db = new DatabaseService(config({ DATABASE_URL: 'postgresql://u@127.0.0.1:1/x', ...env }));
    await db.onModuleDestroy();
    const tlsWarnings = warn.mock.calls.filter(([message]) => String(message).includes('DATABASE_CA_CERT is empty in production'));
    expect(tlsWarnings).toHaveLength(warned ? 1 : 0);
  });

  it('registers the idle-client error handler on its pool, so a dropped connection cannot crash the process', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const db = new DatabaseService(config({ DATABASE_URL: 'postgresql://u@127.0.0.1:1/x', PGSSLMODE: 'disable' }));
    const pool = (db as unknown as { pool: EventEmitter }).pool;
    expect(() => pool.emit('error', new Error('server closed the connection unexpectedly'))).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('server closed the connection unexpectedly'));
    await db.onModuleDestroy();
  });
});

describe('runInTransaction — socket errors on the checked-out client', () => {
  /** pg-pool detaches its idle 'error' listener while a client is checked out — an unhandled 'error' event kills the process */
  function emitterClient() {
    return Object.assign(new EventEmitter(), { query: jest.fn().mockResolvedValue({}), release: jest.fn() });
  }

  it('handles an error event emitted mid-transaction (no throw), discards the client with that error', async () => {
    const client = emitterClient();
    const log = { error: jest.fn() };
    const dropped = new Error('Connection terminated unexpectedly');
    const failure = new Error('terminating connection due to administrator command');
    await expect(runInTransaction(client, async () => {
      expect(() => client.emit('error', dropped)).not.toThrow();
      throw failure;
    }, log)).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledWith(dropped);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('database client error during transaction'));
  });

  it('keeps swallowing late error events on the discarded client after release', async () => {
    const client = emitterClient();
    await runInTransaction(client, async () => { client.emit('error', new Error('drop')); }, { error: jest.fn() });
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'drop' }));
    expect(() => client.emit('error', new Error('late'))).not.toThrow();
  });

  it('removes its listener before handing a healthy client back (the pool re-attaches its own idle listener)', async () => {
    const client = emitterClient();
    await runInTransaction(client, async () => 'ok', { error: jest.fn() });
    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });
});
