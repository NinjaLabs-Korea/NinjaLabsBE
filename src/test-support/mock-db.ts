import type { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from './expect-params-match';

type QueryMock = jest.Mock;

export interface MockDbOptions {
  /** pool 경로(`db.query`)가 위임할 mock. 생략하면 새 `jest.fn()` */
  query?: QueryMock;
  /** 트랜잭션 경로(`db.tx` 콜백의 `tx.query`)가 위임할 mock. 생략하면 새 `jest.fn()`. pool과 같은 mock을 넘기면 한 스크립트를 공유한다 */
  txQuery?: QueryMock;
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
}

/**
 * 유닛 스펙용 `DatabaseService` stand-in. pool(`db.query`)과 트랜잭션(`db.tx` 콜백의 `tx.query`) 두 경로 모두
 * `withParamsCheck`로 감싸 SQL `$n` ↔ 바인딩 개수 드리프트를 어느 경로에서도 잡는다.
 * `db.query`/`db.tx`는 둘 다 `jest.fn`이라 `expect(db.query).not.toHaveBeenCalled()`(트랜잭션 밖 실행 금지)나
 * `toHaveBeenCalledTimes`/ `toHaveBeenCalledTimes`/`mockRejectedValueOnce` 등을 그대로 쓸 수 있고,
 * 콜백이 던지면 그대로 reject(롤백 시뮬레이션은 호출 측 mock 몫).
 */
export function createMockDb(options: MockDbOptions = {}): MockDb {
  const query = options.query ?? jest.fn();
  const txQuery = options.txQuery ?? jest.fn();
  const txClient = { query: withParamsCheck(txQuery) };
  const db = {
    query: jest.fn(withParamsCheck(query)),
    tx: jest.fn(async (callback: (tx: { query: QueryMock }) => Promise<unknown>) => callback(txClient)),
  };
  return { database: db as unknown as DatabaseService, db, query, txQuery, txClient };
}
