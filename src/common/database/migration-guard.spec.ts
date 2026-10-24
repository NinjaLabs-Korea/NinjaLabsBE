import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertNoTransactionControl, findTransactionControl, MIGRATIONS_DIR, migrationFiles } from '../../../scripts/migrate';

/** scripts/migrate.js — 최상위 트랜잭션 제어문 검사 (실 DB 동작은 src/test-db/migrate-runner.db-spec.ts) */
describe('findTransactionControl', () => {
  it.each([
    ['BEGIN;', [{ line: 1, keyword: 'BEGIN' }]],
    ['begin transaction;', [{ line: 1, keyword: 'BEGIN' }]],
    ['BEGIN WORK;', [{ line: 1, keyword: 'BEGIN' }]],
    ['START TRANSACTION;', [{ line: 1, keyword: 'START TRANSACTION' }]],
    ['start   transaction isolation level serializable;', [{ line: 1, keyword: 'START TRANSACTION' }]],
    ['COMMIT;', [{ line: 1, keyword: 'COMMIT' }]],
    ['commit', [{ line: 1, keyword: 'COMMIT' }]], // last statement without a semicolon
    ['END;', [{ line: 1, keyword: 'END' }]],
    ['ROLLBACK;', [{ line: 1, keyword: 'ROLLBACK' }]],
    ['Rollback To Savepoint s;', [{ line: 1, keyword: 'ROLLBACK' }]],
    ['CREATE TABLE a (id int);\n\nCOMMIT;\nSELECT 1;', [{ line: 3, keyword: 'COMMIT' }]],
    ['BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;', [{ line: 1, keyword: 'BEGIN' }, { line: 3, keyword: 'COMMIT' }]],
    ['-- header\n/* block */\n  BEGIN;', [{ line: 3, keyword: 'BEGIN' }]],
    ['SELECT 1; /* c */ COMMIT;', [{ line: 1, keyword: 'COMMIT' }]],
    ['DO $$ BEGIN PERFORM 1; END $$;\nCOMMIT;', [{ line: 2, keyword: 'COMMIT' }]],
  ])('flags %p', (sql, expected) => {
    expect(findTransactionControl(sql)).toEqual(expected);
  });

  it.each([
    ['DO $$ BEGIN RAISE NOTICE \'x\'; END $$;'],
    ['DO $$\nBEGIN\n  IF true THEN\n    COMMIT;\n  END IF;\nEND\n$$;'],
    ['DO $body$ BEGIN PERFORM 1; END $body$;'],
    ['DO $a$ BEGIN PERFORM $b$ ; END; $b$; END $a$;'], // nested tag inside another tag
    ['CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  NEW.updated_at = now();\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;'],
    ['CREATE PROCEDURE p() LANGUAGE plpgsql AS $proc$ BEGIN COMMIT; ROLLBACK; END $proc$;'],
    ['-- BEGIN;\nSELECT 1; -- COMMIT;'],
    ['/* BEGIN;\nCOMMIT; */ SELECT 1;'],
    ['/* outer /* nested */ COMMIT; still comment */ SELECT 1;'],
    ["SELECT 'BEGIN; COMMIT;';"],
    ["SELECT 'it''s; COMMIT';"],
    ["SELECT E'a\\'; COMMIT; \\'b';"],
    ['SELECT "COMMIT"; SELECT 1 AS "x;END";'],
    ['UPDATE t SET end_at = now() WHERE begin_at IS NULL;'],
    ['SELECT CASE WHEN true THEN 1 ELSE 2 END;'],
    ["COMMENT ON TABLE t IS 'commit log';"],
    ['SELECT $1::text; SELECT foo$bar FROM t;'],
    ['CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END;\n  SELECT 2;\nEND;\nSELECT 3;'],
    [''],
  ])('ignores %p', (sql) => {
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it('every shipped migration (0001…) passes', () => {
    const files = migrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(16);
    expect(() => assertNoTransactionControl(MIGRATIONS_DIR)).not.toThrow();
  });
});

describe('assertNoTransactionControl', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ninjalabs-guard-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names every offending file and line, and attaches the first one as err.file / err.line', () => {
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int);\nCOMMIT;');
    writeFileSync(join(dir, '0003_bad.sql'), '\n\nBEGIN;\nSELECT 1;\nEND;');
    let error: (Error & { file?: string; line?: number; problems?: unknown[] }) | undefined;
    try { assertNoTransactionControl(dir); } catch (e) { error = e as typeof error; }
    expect(error?.message).toContain('0002_bad.sql:2 COMMIT, 0003_bad.sql:3 BEGIN, 0003_bad.sql:5 END');
    expect(error).toMatchObject({ file: '0002_bad.sql', line: 2 });
    expect(error?.problems).toHaveLength(3);
  });

  it('passes a clean directory', () => {
    writeFileSync(join(dir, '0001_ok.sql'), 'DO $$ BEGIN PERFORM 1; END $$;');
    expect(() => assertNoTransactionControl(dir)).not.toThrow();
  });
});
