# NinjaLabs Backend

Injective 생태계 빌더 커뮤니티 & 바운티 마켓플레이스 [NinjaLabsFE](https://github.com/NinjaLabs-Korea/NinjaLabsFE)의 백엔드.

**스택**: NestJS 11 · TypeScript 5.9 · PostgreSQL (Supabase) · raw SQL(pg) · CW-721 Nestable NFT (Injective)

## 구조

```
supabase/migrations/   스키마의 소스 오브 트루스 (ERD v1 → SQL, 24 테이블)
src/
  common/database/     pg Pool 기반 DatabaseService (query + tx 헬퍼) + SchemaGuard (미적용 마이그레이션이 있으면 기동 거부)
  auth/                구글 OAuth → JWT 세션, AuthGuard / AdminGuard
  users/               온보딩 프로필, 닉네임 중복검사, 공개 프로필
  wallets/             지갑 연결 challenge/verify (nonce 서명 방식)
  members/             공식 멤버 탭 (공개) + 운영자 멤버 지정
  notices/             공지/소식 (공개 읽기) + 운영자 공지 관리
  highlights/          Hall of Fame 큐레이션 + 자동 집계 지표 + 운영자 관리
  media/               관리자 이미지 업로드 + 공개 immutable 조회
  bounties/            바운티 목록/상세 + applications + submissions(리비전)
    bounty-status.ts     바운티 상태 집합·전이표의 단일 출처
    admin/               운영자 바운티 관리 + 전이 차단 사유(lifecycle)
  rewards/             선입금 확인 → payout 멱등 지급 흐름 (운영자 API 포함)
  nfts/                부모/자식 NFT + nft_job 비동기 워커 (1분 폴링)
  agents/              AI 에이전트 등록/검증/API key + Agent API 인증
  audit/               감사 로그 기록(AuditService) + 조회
  test-db/             실 Postgres 통합 테스트 (npm run test:db) — 하네스 + *.db-spec.ts
  test-support/        유닛 스펙 공용 헬퍼 (expectParamsMatch: SQL $n 수와 바인딩 수 일치 검사)
scripts/migrate.js     Supabase CLI 없이 쓰는 마이그레이션 러너 (applyMigrations는 test-db도 사용)
docs/
  api-contract.md      FE와 합의할 REST API 계약 (FE docs/auth-api-contract.md 대응)
  decisions.md         미결정 사항에 대한 MVP 디폴트 제안
  security.md          보안 체크리스트 (반영됨 / 구현 시 필수 / 운영 전 조치)
```

### 코드 배치 규칙

- **운영자 API는 도메인 모듈 안에 둔다.** `/admin/*` 라우트는 전용 `admin` 모듈이 아니라 해당 도메인 모듈의
  `*-admin.controller.ts` / `*-admin.service.ts`에 있다 (예: `notices/notice-admin.*`, `bounties/admin/*`).
  모든 운영자 컨트롤러는 `@UseGuards(AdminGuard)`를 붙이고 `AuthedRequest`로 `req.user`를 받는다.
- **감사 로그는 `AuditService.record()`로만 남긴다.** 트랜잭션 안이면 `tx`를 마지막 인자로 넘긴다.
- **바운티 상태 문자열 배열을 직접 만들지 않는다.** `bounties/bounty-status.ts`의 `BountyStatusPolicy`를 쓴다.
- **유니크 충돌 판별은 `isUniqueViolation(err)`** (`common/database/pg-errors.ts`).
- **사람/에이전트 참여는 `BountyActor`로 표현한다** (`bounties/bounty-actor.ts`). `isAgent ? ... : ...` 분기를 새로 만들지 않는다.
- **지갑 서명 검증은 `signatureSchemeFor(address).verify()`** (`common/crypto/wallet-signature.ts`). 새 지갑 종류는 구현체를 추가한다.
- **`process.env`를 직접 읽지 않는다.** 서비스는 `ConfigService`를 주입받고, `main.ts`도 `NestFactory.create()` 뒤 `app.get(ConfigService)`로 읽는다
  (import 시점의 `process.env`는 `ConfigModule.forRoot()`가 `.env`를 읽기 전이다). JWT 시크릿은 `auth/jwt-secret.ts`의 `JWT_SECRET` provider 하나를 JwtModule과 AuthService가 함께 쓴다.
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

PR 전 체크: `npm run lint && npm run typecheck && npm test && npm run build` (CI와 동일).

### 배포 순서 (Railway) — 마이그레이션이 먼저, 코드가 나중

새 BE 코드는 새 스키마를 전제로 한다 (예: 0014의 `auth_session` 컬럼이 없으면 `/auth/exchange`·`/auth/refresh`가 500). 그래서 두 겹으로 막는다.

1. **`.railway/railway.ts`의 `preDeploy: "npm run migrate"`** — Railway가 새 컨테이너를 띄우기 전에 `supabase/migrations`를 적용한다
   (`railway` 패키지 `IntentServiceConfig.preDeploy`). 실패하면 배포가 중단되고 구 버전이 계속 서비스된다.
2. **`SchemaGuard`** (`common/database/schema-guard.ts`, `DatabaseModule`의 `onModuleInit`) — 기동 시 `supabase/migrations/*.sql` 전부가
   `_migrations`에 있는지 확인하고, 빠진 게 있으면 listen 전에 `FATAL: MIGRATIONS_PENDING: run npm run migrate (missing: 0014_…)`를 찍고 exit 1.
   preDeploy를 우회해 배포했거나(수동 `railway up`, 다른 호스팅) `npm run migrate`가 실패한 채 컨테이너만 올라오는 상황을 잡는다.

따라서 수동 배포라면 **`npm run migrate` → 새 코드 기동** 순서를 지킨다. `scripts/migrate.js`는 파일 하나를 트랜잭션 하나로 적용하고
`RAISE NOTICE`/실패 시 `HINT`를 그대로 출력한다. `0014`는 `deposit_tx_hash`/`payout_tx_hash` 중복이 남아 있으면 **에러로 멈춘다**(중복 값·건수·조사 SQL 포함) —
운영자가 정리한 뒤 다시 `npm run migrate`하면 이어서 적용된다 (`src/test-db/migrations.db-spec.ts`).

### 실 DB 통합 테스트 (`npm run test:db`)

`npm test`는 DB를 mock한다. 세션 발급/갱신·에이전트 등록/폐기·지갑 challenge/verify·바운티→보상→payout→자식 NFT·공지·정리 크론처럼
SQL이 핵심인 흐름은 `src/test-db/*.db-spec.ts`가 **실제 Postgres**에서 진짜 `DatabaseService`와 서비스로 검증한다 (`jest.db.config.js`).

```bash
# CREATE DATABASE 권한이 있는 접속 문자열. 실행마다 ninjalabs_test_<id> DB를 만들고 supabase/migrations를
# scripts/migrate.js의 applyMigrations()로(운영과 같은 코드) 적용한 뒤 끝나면 지운다 (KEEP_TEST_DB=1이면 남김).
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:db
```

`TEST_DATABASE_URL`이 없으면 전부 skip되며 이유를 출력한다. 로컬/CI Postgres는 TLS가 없으므로 기본 `PGSSLMODE=disable`로 붙는다 (TLS DB면 `TEST_PGSSLMODE=require`).
CI의 `db-tests` 잡이 `postgres:16` 서비스 컨테이너로 같은 명령을 돌린다.

Supabase 프로젝트 생성 후 `Project Settings → Database → Connection string`을 `DATABASE_URL`에 넣으면 된다. Supabase CLI를 쓰는 팀이면 `npm run migrate` 대신 `supabase db push`도 가능 (마이그레이션 디렉터리 규칙 호환).
