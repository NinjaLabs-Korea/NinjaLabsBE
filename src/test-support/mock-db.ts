import type { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from './expect-params-match';

type QueryMock = jest.Mock;

export interface MockDbOptions {
  /** pool 경로(`db.query`)가 위임할 mock. 생략하면 새 `jest.fn()` */
  query?: QueryMock;
  /** 트랜잭션 경로(`db.tx` 콜백의 `tx.query`)가 위임할 mock. 생략하면 새 `jest.fn()`. pool과 같은 mock을 넘기면 한 스크립트를 공유한다 */
  txQuery?: QueryMock;
  /**
   * 엄격 모드 - 등록된 핸들러(`handlers` 또는 `MockDb.handle`)에 맞지 않는 SQL은 `Unexpected SQL: <앞 80자>`로 throw 한다.
   * 허용적 기본값(`{ rowCount: 1, rows: [] }`)으로 새 문장이 검증 없이 통과하는 일을 막는다. `query` 옵션과 함께 쓰지 않는다.
   * 생략하면 기존 동작 그대로.
   */
  strict?: boolean;
  /** 엄격 모드의 초기 핸들러 (앞에서부터 처음 맞는 것이 응답) */
  handlers?: SqlHandler[];
}

export interface SqlResult {
  rowCount: number;
  rows: unknown[];
}

/** 엄격 모드 핸들러 - `match`는 공백을 한 칸으로 접은 SQL에 적용된다 (공백/줄바꿈만 바꾼 SQL 수정에 스펙이 깨지지 않게) */
export interface SqlHandler {
  match: RegExp;
  reply: (params: unknown[] | undefined, sql: string) => SqlResult | Promise<SqlResult>;
}

/** 공백(줄바꿈 포함)을 한 칸으로 접고 앞뒤를 자른다 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export interface MockDb {
  /** `DatabaseService` 자리에 그대로 주입할 수 있는 stand-in (`query` + `tx`) */
  database: DatabaseService;
  /** 같은 객체를 mock 타입으로 본 것 — `db.tx.mock.calls` 등을 단언할 때 */
  db: { query: QueryMock; tx: jest.Mock };
  /** 호출 기록을 단언하는 원본 mock (검사 래퍼가 아니라 위임 대상) */
  query: QueryMock;
  txQuery: QueryMock;
  /** 모든 `db.tx` 콜백이 받는 동일한 클라이언트 객체 — "같은 트랜잭션 클라이언트로 넘겼다"를 `toHaveBeenCalledWith(txClient, ...)`로 단언할 때 */
  txClient: { query: QueryMock };
  /** 엄격 모드 핸들러를 맨 앞에 추가한다 (테스트별 덮어쓰기) */
  handle: (match: RegExp, reply: SqlHandler['reply']) => void;
  /** pool 경로로 실행된 문장 중 `match`에 맞는 것을 호출 순서대로 (SQL은 공백 정규화). 위치 인덱스 대신 이것으로 단언한다 */
  statements: (match: RegExp) => Array<{ sql: string; params: unknown[] | undefined }>;
}

/**
 * 유닛 스펙용 `DatabaseService` stand-in. pool(`db.query`)과 트랜잭션(`db.tx` 콜백의 `tx.query`) 두 경로 모두
 * `withParamsCheck`로 감싸 SQL `$n` ↔ 바인딩 개수 드리프트를 어느 경로에서도 잡는다.
 * `db.query`/`db.tx`는 둘 다 `jest.fn`이라 `expect(db.query).not.toHaveBeenCalled()`(트랜잭션 밖 실행 금지)나
 * `toHaveBeenCalledTimes`/`mockRejectedValueOnce` 등을 그대로 쓸 수 있고,
 * 콜백이 던지면 그대로 reject(롤백 시뮬레이션은 호출 측 mock 몫).
 */
export function createMockDb(options: MockDbOptions = {}): MockDb {
  const handlers: SqlHandler[] = [...(options.handlers ?? [])];
  const strictRouter = async (sql: string, params?: unknown[]) => {
    const normalized = normalizeSql(sql);
    const handler = handlers.find((candidate) => candidate.match.test(normalized));
    if (!handler) throw new Error(`Unexpected SQL: ${normalized.slice(0, 80)}`);
    return handler.reply(params, normalized);
  };
  const query = options.query ?? (options.strict ? jest.fn(strictRouter) : jest.fn());
  const txQuery = options.txQuery ?? (options.strict ? jest.fn(strictRouter) : jest.fn());
  const txClient = { query: withParamsCheck(txQuery) };
  const db = {
    query: jest.fn(withParamsCheck(query)),
    tx: jest.fn(async (callback: (tx: { query: QueryMock }) => Promise<unknown>) => callback(txClient)),
  };
  return {
    database: db as unknown as DatabaseService,
    db,
    query,
    txQuery,
    txClient,
    handle: (match, reply) => { handlers.unshift({ match, reply }); },
    statements: (match) =>
      (query.mock.calls as Array<[string, unknown[] | undefined]>)
        .map(([sql, params]) => ({ sql: normalizeSql(sql), params }))
        .filter(({ sql }) => match.test(sql)),
  };
}
