# 테스트

> 테스트 계층과 실행 방법. 무엇을 어디에 써야 하는지 헷갈리면 아래 표부터 본다.

| 명령 | 무엇 | DB | CI |
|---|---|---|---|
| `npm test` | 단위 테스트 + 정적 가드 스펙. DB는 mock(`src/test-support/mock-db.ts`) | 없음 | 필수 |
| `npm run test:db` | SQL이 핵심인 흐름을 실제 Postgres에서 (`src/test-db/*.db-spec.ts`) | `TEST_DATABASE_URL` | 필수 (`db-tests`) |
| `npm run test:e2e` | 진짜 `AppModule`을 띄워 HTTP로 (`src/test-e2e/*.e2e-spec.ts`) | `TEST_DATABASE_URL` | 필수 (`e2e-tests`) |
| `npm run test:mutation` 외 2개 | 돈 경로 뮤테이션 테스트 | `TEST_DATABASE_URL` | 수동 실행만 |

PR 전에는 CI와 같은 `npm run lint && npm run typecheck && npm test && npm run build`를 돌리고, Postgres가 있으면 `test:db`와 `test:e2e`도 돌린다.
mock DB 단위 테스트는 SQL 타입 추론(42P08 등)을 잡지 못한다. 새 SQL 흐름은 `src/test-db`에 실 DB 테스트를 추가한다.

## 실 DB 통합 테스트 (`npm run test:db`)

`npm test`는 DB를 mock한다. 세션 발급/갱신·에이전트 등록/폐기·바운티→보상→지급 주소→payout·공지·정리 크론처럼
SQL이 핵심인 흐름은 `src/test-db/*.db-spec.ts`가 **실제 Postgres**에서 진짜 `DatabaseService`와 서비스로 검증한다 (`jest.db.config.js`).

```bash
# CREATE DATABASE 권한이 있는 접속 문자열. 실행마다 ninjalabs_test_<id> DB를 만들고 supabase/migrations를
# scripts/migrate.js의 applyMigrations()로(운영과 같은 코드) 적용한 뒤 끝나면 지운다 (KEEP_TEST_DB=1이면 남김).
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:db
```

`TEST_DATABASE_URL`이 없으면 로컬에서는 전부 skip되며 이유를 출력한다 - 단 `CI=true`이면 skip 대신 **실패**한다 (시크릿/env가 빠진 CI 잡이 조용히 초록이 되지 않게, `src/test-db/harness.ts` `testDatabaseUrl()`). 로컬/CI Postgres는 TLS가 없으므로 기본 `PGSSLMODE=disable`로 붙는다 (TLS DB면 `TEST_PGSSLMODE=require`).
CI의 `db-tests` 잡이 `postgres:16` 서비스 컨테이너로 같은 명령을 돌린다. 스위트는 테스트 순서에 기대지 않으므로 `npm run test:db -- --randomize`로도 통과해야 하고, 정렬 단언은 collation에 기대지 않는다(`COLLATE "C"` 또는 JS 정렬).

## HTTP e2e 테스트 (`npm run test:e2e`)

`src/test-e2e/*.e2e-spec.ts`는 **진짜 `AppModule` 전체**를 `src/main.ts`와 같은 `configureApp()`(`src/app-setup.ts` - 전역 ValidationPipe
`whitelist+forbidNonWhitelisted+transform`, HttpExceptionFilter, RequestLoggingInterceptor, CORS 허용 목록, trust proxy, helmet)으로 구성해
`listen(0)` 하고 HTTP로 구동한다 (`jest.e2e.config.js`). 스로틀러·AdminGuard·SchemaGuard·크론 모듈까지 모두 실물이며 DB는 `test:db`와 같은
global-setup이 매 실행 새로 만든 데이터베이스(모든 마이그레이션 적용)다. 요청 본문은 FE가 만드는 그대로 만든다(`support/fe-payloads.ts` -
`NinjaLabsFE/src/lib/api/*.ts` 매핑을 옮긴 것, undefined 키 제거·지운 URL은 `null`).

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:e2e   # E2E_LOG=1이면 앱 로그를 출력
```

- **대역은 외부 I/O만** (`support/fakes.ts`): Google 토큰 엔드포인트(전역 `fetch` 가로채기 - 그 밖의 외부 URL 호출은 테스트 실패) + `GoogleIdTokenVerifier`.
  `@injectivelabs/sdk-ts`·`@cosmjs/amino`는 ESM 전용이라 jest가 못 불러오므로 `moduleNameMapper`로 바꾼다 - 주소 변환은 실제 bech32
  구현(sdk-ts와 같은 결과를 벡터로 검사), 체인/ADR-36 클래스는 호출 시 실패. 시간은 Postgres `now()` 기준 행을 옮겨(예: 회전 시각을 31초 전으로) 다룬다.
- **환경 격리**: 하네스가 앱이 읽는 env 키를 전부 덮어써 개발자 `.env`의 시크릿/DB가 섞이지 않는다. `TRUST_PROXY=1`이고 요청마다 무작위
  `X-Forwarded-For`를 붙여 IP별 스로틀 버킷을 나눈다(스로틀 스펙은 IP를 지정).
- **로그**: 모든 Nest 로그를 수집하고, 파일마다 끝에서 니모닉·JWT/Google 시크릿·발급된 토큰·API 키·로그인 코드가 한 줄도 없는지 단언한다.
- 결함 회귀는 해당 스펙에 남는다. 제품 결정이 필요한 것은 `it.todo`에 이유와 함께 둔다.

`TEST_DATABASE_URL`이 없으면 로컬은 skip, `CI=true`면 실패한다 (`test:db`와 동일). CI의 `e2e-tests` 잡이 같은 `postgres:16` 서비스로 실행한다.
새 전역 파이프/필터/미들웨어는 `main.ts`가 아니라 `configureApp()`에 추가해야 e2e가 검증한다.

## 돈 경로 뮤테이션 테스트 (`npm run test:mutation`)

테스트가 돈 경로의 잘못된 변경을 실제로 잡는지 확인한다. 코드를 일부러 조금씩 바꿔(변형) 테스트가 실패하는지 본다. CI에는 붙이지 않고 로컬에서 수동으로 돌린다.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:mutation          # src의 돈 경로 TS (Stryker)
TEST_DATABASE_URL=... npm run test:mutation:scripts   # scripts/record-refund.js, scripts/forfeit-award.js
TEST_DATABASE_URL=... npm run test:mutation:sql       # SQL 문자열 안의 조건 변형 (mutation/sql-mutants.mjs)
```

- 대상 파일 목록과 범위는 `stryker.config.mjs` 머리 주석, SQL 변형 목록은 `mutation/sql-mutants.mjs`에 있다. 테스트는 `jest.mutation.config.js`(단위 + 실DB)로 돈다.
- 결과: `reports/mutation/mutation.html`, `reports/mutation/sql-mutants.json`.
- 동시성은 코어 수의 절반 이하로 둔다. 러너마다 DB를 하나씩 만든다.
- SQL 변형의 원문이 코드에서 정확히 한 번 나오지 않으면 그 변형은 `STALE`로 나온다. 코드가 바뀐 것이니 목록을 고친다.
