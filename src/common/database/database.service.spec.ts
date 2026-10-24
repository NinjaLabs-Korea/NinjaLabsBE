import { EventEmitter } from 'events';
import { attachPoolErrorHandler, runInTransaction } from './database.service';

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
