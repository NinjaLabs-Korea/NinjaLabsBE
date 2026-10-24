# NinjaLabs Backend

Injective 생태계 빌더 커뮤니티 & 바운티 마켓플레이스 [NinjaLabsFE](https://github.com/NinjaLabs-Korea/NinjaLabsFE)의 백엔드.

**스택**: NestJS 11 · TypeScript 5.9 · PostgreSQL (Supabase) · raw SQL(pg) · CW-721 Nestable NFT (Injective)

## 구조

```
supabase/migrations/   스키마의 소스 오브 트루스 (ERD v1 → SQL, 24 테이블 + 운영용 `throttler_storage`)
src/
  common/database/     pg Pool 기반 DatabaseService (query + tx 헬퍼, 연결/문장 타임아웃 — pool-timeouts.ts) + SchemaGuard (미적용 마이그레이션이 있으면 기동 거부)
  common/http/         요청 id, 쿠키, 전역 예외 필터, 요청 로깅 인터셉터, 에러 코드 카탈로그(error-codes.ts)
  common/logging/      로그 안전 헬퍼(log-safe) + 온보딩 로그
  common/throttler/    rate limit 설정 (memory | postgres 저장소, 공개 읽기 스로틀)
  common/maintenance/  만료 데이터 정리 크론 (MaintenanceService)
  common/validation/   DTO 공용 검증기 (trim, URL, tx hash, 토큰 금액, 글자 수)
  common/crypto/      지갑 서명 검증 (EIP-191 / ADR-36)
  health/              GET /health (DB 연결 확인)
  deploy/              배포 설정 가드 스펙 (railway-config, audit-gate) — 런타임 코드 없음
  common/alerts/       운영 알림 AlertService (OPS_ALERT_WEBHOOK_URL 웹훅, 없으면 로그만) + 기동 실패 알림 + 5xx 버스트 감지
  auth/                구글 OAuth → JWT 세션, AuthGuard / AdminGuard
  users/               온보딩 프로필, 닉네임 중복검사, 공개 프로필, 회원 탈퇴(account-withdrawal.service)
  wallets/             지갑 연결 challenge/verify (nonce 서명 방식)
  members/             공식 멤버 탭 (공개) + 운영자 멤버 지정
  notices/             공지/소식 (공개 읽기) + 운영자 공지 관리
  highlights/          Hall of Fame 큐레이션 + 자동 집계 지표 + 운영자 관리
  media/               관리자 이미지 업로드 + 공개 immutable 조회
  bounties/            바운티 목록/상세 + applications + submissions(리비전)
    bounty-status.ts     바운티 상태 집합·전이표·공개 노출 조건(publicBountySql)의 단일 출처
    submission-status.ts 제출물 상태 집합·심사 결정표·코멘트 필수 규칙의 단일 출처
    application-status.ts 지원서 상태·심사 결정·재지원 규칙의 단일 출처
    admin/               운영자 바운티 관리 + 전이 차단 사유(lifecycle)
  rewards/             선입금 확인 → payout 멱등 지급 흐름 (운영자 API 포함)
    payout-status.ts     payout 상태 집합(진행 중·종료·배정·미정산)·배정 상한식·제출별 지급 상태 SQL의 단일 출처
  nfts/                부모/자식 NFT + nft_job 비동기 워커 (1분 폴링) + 운영자 잡 콘솔(nft-jobs-admin.*: 목록/재시도)
  agents/              AI 에이전트 등록/검증/API key + Agent API 인증
  audit/               감사 로그 기록(AuditService) + 조회
  test-db/             실 Postgres 통합 테스트 (npm run test:db) — 하네스 + *.db-spec.ts
  test-e2e/            HTTP e2e (npm run test:e2e) — 진짜 AppModule + 실 Postgres, 외부 I/O만 대역 (support/)
  app-setup.ts         configureApp(): 전역 파이프/필터/인터셉터/CORS/trust proxy — main.ts와 e2e가 공유
  test-support/        유닛 스펙 공용 헬퍼 + 정적 가드 스펙
    mock-db.ts           createMockDb({ query?, txQuery? }) — DatabaseService stand-in. pool(db.query)과 tx 클라이언트 두 경로 모두 withParamsCheck 적용.
                         새 서비스 스펙은 직접 { query, tx }를 만들지 말고 이걸 쓴다
    expect-params-match.ts expectParamsMatch / withParamsCheck (SQL $n 수와 바인딩 수 일치 검사)
    migration-check.ts   마이그레이션 CHECK 값 집합 파서 (상태 집합 스펙이 코드 ↔ 스키마 대조에 사용)
    *.spec.ts            정적 가드: status-literals(상태 집합 리터럴), error-codes(코드 카탈로그), sql-param-casts($n 캐스트 일관성), ops-cli(scripts/ops-cli.js)
scripts/migrate.js     Supabase CLI 없이 쓰는 마이그레이션 러너 (applyMigrations는 test-db도 사용). 실패 시 운영 알림
scripts/ops-alert.js   웹훅 전송 함수 postOpsAlert (절대 throw 안 함) — migrate.js와 src/common/alerts가 공유
scripts/grant-admin.js       운영자 권한 부여/회수 (이메일, --dry-run, 확인 프롬프트, 감사 행) — docs/runbook.md §3
scripts/requeue-nft-jobs.js  FAILED nft_job 수동 재시도 (id 또는 --all, --dry-run) — docs/runbook.md §7.3
scripts/forfeit-award.js     지급할 수 없는 승인 수상 몰수 (APPROVED → REJECTED, 심사 기록 + 감사 행) — docs/runbook.md §7.4
scripts/mainnet-preflight.sql 메인넷 전환 전 읽기 전용 점검 (psql) — docs/runbook.md §8
scripts/find-static-ext-nicknames.sql 정적 파일 확장자로 끝나는 기존 닉네임 목록 (psql, 읽기 전용) — docs/runbook.md §2
scripts/ops-cli.js           운영 스크립트 공용 (migrate.js와 같은 접속 규칙, 인자, 프롬프트)
docs/
  api-contract.md      FE와 합의할 REST API 계약 (FE docs/auth-api-contract.md 대응)
  decisions.md         미결정 사항에 대한 MVP 디폴트 제안
  security.md          보안 체크리스트 (반영됨 / 구현 시 필수 / 운영 전 조치)
  runbook.md           운영 런북 — 첫 배포, 어드민 부트스트랩, OAuth 게시, 백업/복구 리허설, 업타임, 장애 플레이북, 메인넷 전환, 멀티시그 템플릿
```

### 코드 배치 규칙

- **운영자 API는 도메인 모듈 안에 둔다.** `/admin/*` 라우트는 전용 `admin` 모듈이 아니라 해당 도메인 모듈의
  `*-admin.controller.ts` / `*-admin.service.ts`에 있다 (예: `notices/notice-admin.*`, `bounties/admin/*`).
  모든 운영자 컨트롤러는 `@UseGuards(AdminGuard)`를 붙이고 `AuthedRequest`로 `req.user`를 받는다.
- **감사 로그는 `AuditService.record()`로만 남긴다.** 트랜잭션 안이면 `tx`를 마지막 인자로 넘긴다.
- **운영 알림은 `AlertService.notify(key, message)`로만 보낸다** (`common/alerts/alert.service.ts`, 전역 모듈). 절대 throw하지 않으므로 try/catch 불필요.
  `key`는 고정 문자열(또는 `종류:작은 고정 집합` — 예 `nft-job-failed:MINT_CHILD`)이고 같은 키는 30분에 한 번만 나간다(웹훅 전달 성공 기준 — 실패는 2초 뒤 1회 재시도 후 다음 발생이 다시 시도). 메시지에 비밀·PII(이메일, 닉네임, 요청 본문, 실제 경로 값)를 넣지 않는다 — id·개수·상태·라우트 패턴만.
- **바운티 상태 문자열 배열을 직접 만들지 않는다.** `bounties/bounty-status.ts`의 `BountyStatusPolicy`를 쓴다. 공개 노출 조건은 `publicBountySql()`(`opened_at IS NOT NULL`)이다 — 상태 목록으로 거르지 않는다 (정적 가드 `status-literals.spec.ts`).
  제출물·지원서 상태도 같다 — `bounties/submission-status.ts`(`SubmissionStatusPolicy`), `bounties/application-status.ts`(`ApplicationStatusPolicy`).
  SQL의 상태 집합은 helper가 주는 배열을 `= ANY($n::text[])`로 바인딩한다. `src/test-support/status-literals.spec.ts`가 상태 리터럴 집합(`['APPROVED', 'REJECTED']`, `IN ('SUBMITTED', …)`)을 막는다.
  payout 상태 집합과 배정 상한식 `LEAST(amount, deposited_amount)`도 같다 — `rewards/payout-status.ts`의 상수/헬퍼(`OPEN_PAYOUT_STATUSES`, `allocatedPayoutSumSql()`, `rewardCapSql()` 등)를 쓰고,
  다른 쿼리에 끼워 넣는 조각은 `sqlStatusList()`로 렌더링한다. `scripts/record-refund.js`·`scripts/mainnet-preflight.sql`의 사본은 `payout-status.spec.ts`가 대조한다.
- **유니크 충돌 판별은 `isUniqueViolation(err)`** (`common/database/pg-errors.ts`).
- **에러 코드는 `common/http/error-codes.ts` 카탈로그에 등록한다** (코드 → HTTP 상태 → 한 줄 의미). 서비스에는 `throw new XxxException('NEW_CODE')` 리터럴로 던지고, 카탈로그와 `docs/api-contract.md` "에러 코드" 표에 같은 행을 추가한다 — 빠지면 `src/test-support/error-codes.spec.ts`가 실패한다.
- **사람/에이전트 참여는 `BountyActor`로 표현한다** (`bounties/bounty-actor.ts`). `isAgent ? ... : ...` 분기를 새로 만들지 않는다.
- **지갑 서명 검증은 `signatureSchemeFor(address).verify()`** (`common/crypto/wallet-signature.ts`). 새 지갑 종류는 구현체를 추가한다.
- **`process.env`를 직접 읽지 않는다.** 서비스는 `ConfigService`를 주입받고, `main.ts`도 `NestFactory.create()` 뒤 `app.get(ConfigService)`로 읽는다
  (import 시점의 `process.env`는 `ConfigModule.forRoot()`가 `.env`를 읽기 전이다). 예외는 `main.ts`의 기동 실패 catch 하나 — DI가 뜨기 전에
  실패할 수 있어 `alertBootFailure(process.env, …)`가 env를 직접 읽는다(그 시점엔 `ConfigModule.forRoot()`가 `.env`를 이미 올렸다). JWT 시크릿은 `auth/jwt-secret.ts`의 `JWT_SECRET` provider 하나를 JwtModule과 AuthService가 함께 쓴다.
- **SQL에서 같은 `$n`을 두 번 쓰면 캐스트도 같게 쓴다** (`$6::varchar` … `$6::varchar`). 한쪽만 bare/캐스트면 Postgres가 `42P08 inconsistent types deduced for parameter`로 거부한다 —
  mock DB 유닛 테스트는 이를 잡지 못하므로 새 SQL 흐름은 `src/test-db`에 실 DB 테스트를 추가한다.

## 시작하기

요구 사항: Node 22+ · npm

```bash
npm install
cp .env.example .env        # DATABASE_URL 등 채우기
npm run migrate             # supabase/migrations 순서대로 적용
npm run start:dev           # http://localhost:4000
```

PR 전 체크: `npm run lint && npm run typecheck && npm test && npm run build` (CI와 동일) + Postgres가 있으면 `npm run test:db`, `npm run test:e2e`.

#### 로컬 오리진 (CORS / 로그인 returnTo)

production(`.railway/railway.ts`)의 `CORS_ORIGINS`에는 `http://localhost:3000`이 **없다** — 아무 브라우저 탭의 localhost 페이지가 운영 API를 자격 증명과 함께 부를 수 없게.
로컬 FE는 로컬 BE에 붙인다: `.env`(`.env.example` 복사)의 `CORS_ORIGINS=http://localhost:3000`, `AUTH_SUCCESS_REDIRECT=http://localhost:3000/`가 기본값이고,
다른 포트/호스트로 FE를 띄우면 `CORS_ORIGINS`와 `AUTH_ALLOWED_REDIRECT_ORIGINS`에 그 오리진을 콤마로 덧붙인다 (예: `CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3001`).
로컬 FE로 운영 BE를 꼭 써야 한다면 운영 변수를 바꾸지 말고 FE의 mock 모드나 Vercel preview(정확한 별칭 항목)를 쓴다.

### 배포 순서 (Railway) — 마이그레이션이 먼저, 코드가 나중

새 BE 코드는 새 스키마를 전제로 한다 (예: 0014의 `auth_session` 컬럼이 없으면 `/auth/exchange`·`/auth/refresh`가 500). 그래서 두 겹으로 막는다.

1. **`.railway/railway.ts`의 `preDeploy: "npm run migrate"`** — Railway가 새 컨테이너를 띄우기 전에 `supabase/migrations`를 적용한다
   (`railway` 패키지 `IntentServiceConfig.preDeploy`). 실패하면 배포가 중단되고 구 버전이 계속 서비스된다.
2. **`SchemaGuard`** (`common/database/schema-guard.ts`, `DatabaseModule`의 `onModuleInit`) — 기동 시 `supabase/migrations/*.sql` 전부가
   `_migrations`에 있는지 확인하고, 빠진 게 있으면 listen 전에 `FATAL: MIGRATIONS_PENDING: run npm run migrate (missing: 0014_…)`를 찍고 exit 1.
   preDeploy를 우회해 배포했거나(수동 `railway up`, 다른 호스팅) `npm run migrate`가 실패한 채 컨테이너만 올라오는 상황을 잡는다.

따라서 수동 배포라면 **`npm run migrate` → 새 코드 기동** 순서를 지킨다. `scripts/migrate.js`는 실행 전체를 `pg_advisory_lock`(고정 키 `MIGRATION_LOCK_KEY`)으로 직렬화한다 — 두 배포의 preDeploy가 겹치면 뒤의 것은 `wait  another migration run holds the lock`을 찍고 기다렸다가 이미 적용된 파일을 skip한다 (`src/test-db/migrate-lock.db-spec.ts`). 파일 하나를 트랜잭션 하나로 적용하므로 파일 안의 최상위 `BEGIN`/`START TRANSACTION`/`COMMIT`/`END`/`ROLLBACK`은 **실행 전에 거부**한다 (주석·문자열·`$$` 본문은 제외, 모든 파일을 먼저 검사해 하나라도 걸리면 아무것도 실행/기록하지 않고 `FAIL  <file>:<line>`으로 exit 1 — `docs/runbook.md` §2). 적용 중에는
`RAISE NOTICE`/실패 시 `HINT`를 그대로 출력한다. `0014`는 `deposit_tx_hash` 중복이 남아 있으면 **에러로 멈춘다**(중복 값·건수·조사 SQL 포함) —
운영자가 정리한 뒤 다시 `npm run migrate`하면 이어서 적용된다 (`src/test-db/migrations.db-spec.ts`). `payout_tx_hash`는 정규화만 한다 (한 멀티시그 tx가 여러 수상자에게 보낼 수 있어 중복이 정당하다).

첫 배포 전체 순서(Railway 설정 반영 → env → BE → OAuth → FE → 어드민 부트스트랩 → 모니터)와 운영 절차는 **[docs/runbook.md](docs/runbook.md)**.

#### 이 브랜치 첫 배포 전에 있어야 하는 env (production, `NODE_ENV=production`)

기동 검사는 `common/bootstrap-checks.ts`·`auth.service.ts`·`database.service.ts`에 있다. 한 번 올라간 뒤가 아니라 **첫 컨테이너가 뜨기 전에** Railway 변수에 넣어 둔다
(`.railway/railway.ts`의 `preserve()` 자리). 빠지면 아래 "결과" 열대로 동작한다 — 거부되는 것만 크래시 루프가 된다.

| env | 결과 |
|---|---|
| `DATABASE_URL` | 없으면 `preDeploy`의 `npm run migrate`가 실패해 배포 중단 (구 버전 유지) |
| `JWT_SECRET` | 미설정 또는 `.env.example` 자리표시값이면 **기동 거부**. 32바이트 미만이면 기동은 하되 `error` 로그 — 즉시 교체(`openssl rand -base64 48`) |
| `GOOGLE_CLIENT_SECRET` | 없으면 **기동 거부** (로그인이 어차피 전부 실패) |
| `TRUST_PROXY` | 미설정/빈 값이면 **1로 보고 `warn`** (Railway는 항상 프록시 1홉 뒤). 명시적 `0`/비정수는 **기동 거부** — railway.ts가 `1`을 넣는다 |
| `JWT_REFRESH_TTL` | 미설정이면 `14d`. 형식/범위(60초~90일)가 틀리면 기동 거부 |
| `JWT_ACCESS_TTL` | 미설정이면 `15m`. `JWT_REFRESH_TTL`과 같은 문법(`<정수><단위>` — 단위 없는 `900`은 jsonwebtoken이 밀리초로 읽어 발급 즉시 만료되므로 거부), 범위 60초~60분. 틀리면 환경과 무관하게 **기동 거부** — railway.ts가 `15m`을 넣는다 |
| `LEGACY_ACCESS_TOKEN_CUTOFF` | 선택. 미설정이면 프로세스 시작 시각 — 그 전에 발급된 `typ` 없는 구 access 토큰만 받는다(15분 뒤 자연 소멸). ISO 8601이 아니면 기동 거부. 2026-11-30 이후 코드와 함께 제거 |
| `DATABASE_CA_CERT` | 비어 있으면 기동하되 `warn` 1회 (TLS 인증서 미검증 — 운영 전 설정) |
| `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` | 선택, 기본 `5000`/`15000` ms (잘못된 값은 기본값). 연결 수립·풀 대기 초과 → 그 요청 `503 DATABASE_UNAVAILABLE`, 문장 초과 → Postgres 취소(500). migrate/운영 스크립트는 연결 타임아웃만 쓰고 문장 타임아웃은 걸지 않는다 (`common/database/pool-timeouts.ts`) |
| `THROTTLER_STORAGE` | 선택. 미설정이면 production은 `postgres`(레플리카 간 공유 rate limit 카운터, `throttler_storage` — 0016), 그 외는 `memory`(인스턴스별). `postgres`/`memory` 외의 값은 **기동 거부**. railway.ts가 `postgres`를 명시한다 — `memory`로 바꾸면 레플리카 N대에서 한도가 N배 (`docs/security.md`) |
| `TURNSTILE_SECRET_KEY` | 선택. 설정하면 `GET /auth/google`이 Cloudflare Turnstile 토큰(`turnstileToken`)을 요구한다 (400 `TURNSTILE_FAILED` / 503 `TURNSTILE_UNAVAILABLE`). 미설정이면 검사 생략 + production 기동 시 `warn`. **FE(`NEXT_PUBLIC_TURNSTILE_SITE_KEY`)를 먼저 배포**한 뒤 넣는다 — 순서가 바뀌면 모든 로그인이 400 |
| `REWARD_MULTISIG_ADDRESS` | 기동은 하지만 비우면 새 보상의 `custody_address`가 자리표시값 `PENDING_MULTISIG_SETUP` — 스폰서가 입금할 주소가 없다. `railway.ts`의 `preserve()` 자리 — 값은 대시보드/CLI로 넣는다 (`docs/runbook.md` §1, §8) |
| `PAYOUT_ALLOW_SELF_APPROVAL` | 선택, 기본 `false` — payout 승인 2인 규칙(요청자 ≠ 승인자, 403 `PAYOUT_SELF_APPROVAL`). 운영자 1인일 때만 `true` → 자기 승인 허용 + 기동/승인 시 `warn` + 감사 `PAYOUT_SELF_APPROVED`. railway.ts에는 값 없이 `preserve()` 자리만 있다(기본값 유지 — 대시보드에서 켠 값이 apply로 지워지지 않게) |
| `OPS_ALERT_WEBHOOK_URL` | 선택 (railway.ts `preserve()`). Discord/Slack incoming webhook(https). 없으면 알림은 `OpsAlert` warn 로그로만, https가 아니면 기동 시 `error` 로그 후 무시 (기동은 함). 대상·규칙은 `docs/security.md` "운영 알림" |
| `CORS_ORIGINS`, `AUTH_ALLOWED_REDIRECT_ORIGINS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CALLBACK_URL`, `AUTH_SUCCESS_REDIRECT` | 기동은 하지만 값이 틀리면 로그인/CORS가 동작하지 않는다 (railway.ts에 공개값으로 고정) |

### 실 DB 통합 테스트 (`npm run test:db`)

`npm test`는 DB를 mock한다. 세션 발급/갱신·에이전트 등록/폐기·지갑 challenge/verify·바운티→보상→payout→자식 NFT·공지·정리 크론처럼
SQL이 핵심인 흐름은 `src/test-db/*.db-spec.ts`가 **실제 Postgres**에서 진짜 `DatabaseService`와 서비스로 검증한다 (`jest.db.config.js`).

```bash
# CREATE DATABASE 권한이 있는 접속 문자열. 실행마다 ninjalabs_test_<id> DB를 만들고 supabase/migrations를
# scripts/migrate.js의 applyMigrations()로(운영과 같은 코드) 적용한 뒤 끝나면 지운다 (KEEP_TEST_DB=1이면 남김).
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:db
```

`TEST_DATABASE_URL`이 없으면 로컬에서는 전부 skip되며 이유를 출력한다 — 단 `CI=true`이면 skip 대신 **실패**한다 (시크릿/env가 빠진 CI 잡이 조용히 초록이 되지 않게, `src/test-db/harness.ts` `testDatabaseUrl()`). 로컬/CI Postgres는 TLS가 없으므로 기본 `PGSSLMODE=disable`로 붙는다 (TLS DB면 `TEST_PGSSLMODE=require`).
CI의 `db-tests` 잡이 `postgres:16` 서비스 컨테이너로 같은 명령을 돌린다. 스위트는 테스트 순서에 기대지 않으므로 `npm run test:db -- --randomize`로도 통과해야 하고, 정렬 단언은 collation에 기대지 않는다(`COLLATE "C"` 또는 JS 정렬).

### HTTP e2e 테스트 (`npm run test:e2e`)

`src/test-e2e/*.e2e-spec.ts`는 **진짜 `AppModule` 전체**를 `src/main.ts`와 같은 `configureApp()`(`src/app-setup.ts` — 전역 ValidationPipe
`whitelist+forbidNonWhitelisted+transform`, HttpExceptionFilter, RequestLoggingInterceptor, CORS 허용 목록, trust proxy, helmet)으로 구성해
`listen(0)` 하고 HTTP로 구동한다 (`jest.e2e.config.js`). 스로틀러·AdminGuard·SchemaGuard·크론 모듈까지 모두 실물이며 DB는 `test:db`와 같은
global-setup이 매 실행 새로 만든 데이터베이스(모든 마이그레이션 적용)다. 요청 본문은 FE가 만드는 그대로 만든다(`support/fe-payloads.ts` —
`NinjaLabsFE/src/lib/api/*.ts` 매핑을 옮긴 것, undefined 키 제거·지운 URL은 `null`).

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:e2e   # E2E_LOG=1이면 앱 로그를 출력
```

- **대역은 외부 I/O만** (`support/fakes.ts`): Google 토큰 엔드포인트(전역 `fetch` 가로채기 — 그 밖의 외부 URL 호출은 테스트 실패) + `GoogleIdTokenVerifier`,
  `InjectiveNftClient`. `@injectivelabs/sdk-ts`·`@cosmjs/amino`는 ESM 전용이라 jest가 못 불러오므로 `moduleNameMapper`로 바꾼다 — 주소 변환은 실제 bech32
  구현(sdk-ts와 같은 결과를 벡터로 검사), 체인/ADR-36 클래스는 호출 시 실패. 시간은 Postgres `now()` 기준 행을 옮겨(예: 회전 시각을 31초 전으로) 다룬다.
- **환경 격리**: 하네스가 앱이 읽는 env 키를 전부 덮어써 개발자 `.env`의 시크릿/DB가 섞이지 않는다. `TRUST_PROXY=1`이고 요청마다 무작위
  `X-Forwarded-For`를 붙여 IP별 스로틀 버킷을 나눈다(스로틀 스펙은 IP를 지정).
- **로그**: 모든 Nest 로그를 수집하고, 파일마다 끝에서 니모닉·JWT/Google 시크릿·발급된 토큰·API 키·로그인 코드가 한 줄도 없는지 단언한다.
- 결함 회귀는 해당 스펙에 남는다. 제품 결정이 필요한 것은 `it.todo`에 이유와 함께 둔다.

`TEST_DATABASE_URL`이 없으면 로컬은 skip, `CI=true`면 실패한다 (`test:db`와 동일). CI의 `e2e-tests` 잡이 같은 `postgres:16` 서비스로 실행한다.
새 전역 파이프/필터/미들웨어는 `main.ts`가 아니라 `configureApp()`에 추가해야 e2e가 검증한다.

### 요청 ID (`X-Request-Id`)

`configureApp()`의 첫 미들웨어(`src/common/http/request-id.ts`)가 모든 응답에 `X-Request-Id`를 붙인다. 들어온 헤더가 `^[A-Za-z0-9._-]{8,64}$`이면 그대로 쓰고,
아니면(없음·형식 오류·CR/LF 포함·중복 헤더) `randomUUID()`로 새로 만든다. CORS `exposedHeaders`에 포함돼 브라우저 FE가 읽을 수 있다.
요청 로그 줄(`HTTP`)과 5xx 줄(`HttpException`) 끝에 ` rid=<id>`가 붙어, 장애 시 사용자가 알려준 ID로 두 줄을 묶어 찾는다. 응답 본문과 5xx 버스트 알림 본문은 바뀌지 않는다.

### 세션: refresh 토큰 HttpOnly 쿠키 (`X-Ninja-Session: cookie`)

FE는 `/api/auth/*`를 Next.js rewrite로 이 서버의 `/auth/*`에 프록시하고, 요청에 `X-Ninja-Session: cookie`를 붙여 쿠키 모드를 켠다.
그때 `/auth/exchange`·`/auth/refresh`는 refresh 토큰을 `Set-Cookie: ninja_rt=…; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=<JWT_REFRESH_TTL 초>`(Domain 없음)로만 주고
본문에서 뺀다(`{accessToken}`), `/auth/refresh`는 쿠키를 읽고(본문 `{}`), `/auth/logout`은 쿠키를 지운다(`Max-Age=0`). 헤더가 없으면 쿠키는 무시되고 기존 본문 모드(deprecated)다 — 커스텀 헤더가 CSRF 방어선.
쿠키는 의존성 없이 `common/http/cookies.ts`로 읽는다. `/auth/refresh`·`/auth/exchange` 한도는 IP가 아니라 제시된 토큰/코드의 해시별 10/min(`auth/auth-throttler.guard.ts`) + IP당 600/min(이 두 라우트만 전역 120/min을 올림 — Vercel rewrite 뒤 사용자들이 소수의 egress IP를 공유, `docs/security.md`). 계약 전문: `docs/api-contract.md` "refresh 쿠키 모드", 보안 모델: `docs/security.md`.
로컬에서 `Secure` 쿠키는 `http://localhost`에서도 브라우저가 받는다(localhost는 secure context).

Supabase 프로젝트 생성 후 `Project Settings → Database → Connection string`을 `DATABASE_URL`에 넣으면 된다. Supabase CLI를 쓰는 팀이면 `npm run migrate` 대신 `supabase db push`도 가능 (마이그레이션 디렉터리 규칙 호환).
