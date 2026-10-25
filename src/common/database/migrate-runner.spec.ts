import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Pool } from 'pg';
import { applyMigrations } from '../../../scripts/migrate';

/** scripts/migrate.js applyMigrations — 연결이 실행 도중 끊기는 경우 (정상 경로는 src/test-db/migrate-runner.db-spec.ts) */
describe('applyMigrations when the connection dies mid-run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrate-runner-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function brokenClient() {
    const client = Object.assign(new EventEmitter(), { release: jest.fn(), query: jest.fn() });
    const dropped = new Error('Connection terminated unexpectedly');
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ ok: true }] };
      if (text.startsWith('SELECT 1 FROM _migrations')) return { rowCount: 0, rows: [] };
      if (text === 'SELECT 1;') {
        // pg는 활성 쿼리를 reject하면서 클라이언트에 'error'도 emit한다 — 리스너가 없으면 uncaught exception
        client.emit('error', dropped);
        throw dropped;
      }
      if (text === 'BEGIN' || text.startsWith('CREATE TABLE')) return { rows: [] };
      throw new Error('Client has encountered a connection error and is not queryable'); // ROLLBACK, unlock
    });
    return { client, dropped };
  }

  it('rejects with the original error tagged with the file, and discards the client instead of crashing the process', async () => {
    const { client, dropped } = brokenClient();
    const pool = { connect: async () => client } as unknown as Pool;
    const log = jest.fn();

    const failure = await applyMigrations(pool, { dir, log }).catch((err: unknown) => err);

    expect(failure).toBe(dropped);
    expect((failure as { file?: string }).file).toBe('0001_a.sql');
    expect(client.release).toHaveBeenCalledWith(dropped); // 깨진 클라이언트는 풀에서 폐기
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Connection terminated unexpectedly'));
    expect(() => client.emit('error', new Error('late'))).not.toThrow(); // 늦게 오는 'error'도 삼킨다
  });
});
