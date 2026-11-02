# 코드 규칙

> BE에서 새 코드를 쓸 때 지키는 규칙 전문이다. README "꼭 지킬 규칙"은 이 문서의 요약이다.
> 여러 규칙은 정적 가드 스펙(`src/test-support/*.spec.ts`, `common/database/sql-predicates.spec.ts` 등)이 지키므로, 어기면 `npm test`가 실패한다.

## 모듈 배치와 의존성

- **운영자 API는 도메인 모듈 안에 둔다.** `/admin/*` 라우트는 전용 `admin` 모듈이 아니라 해당 도메인 모듈의
  `*-admin.controller.ts` / `*-admin.service.ts`에 있다 (예: `notices/notice-admin.*`, `bounties/admin/*`).
  모든 운영자 컨트롤러는 `@UseGuards(AdminGuard)`를 붙이고 `AuthedRequest`로 `req.user`를 받는다.
- **사람/에이전트 참여는 `BountyActor`로 표현한다** (`bounties/bounty-actor.ts`). `isAgent ? ... : ...` 분기를 새로 만들지 않는다.
- **지갑 서명 검증은 `signatureSchemeFor(address).verify()`** (`common/crypto/wallet-signature.ts`). 새 지갑 종류는 구현체를 추가한다.
- **`process.env`를 직접 읽지 않는다.** 서비스는 `ConfigService`를 주입받고, `main.ts`도 `NestFactory.create()` 뒤 `app.get(ConfigService)`로 읽는다
  (import 시점의 `process.env`는 `ConfigModule.forRoot()`가 `.env`를 읽기 전이다). 예외는 `main.ts`의 기동 실패 catch 하나 - DI가 뜨기 전에
  실패할 수 있어 `alertBootFailure(process.env, …)`가 env를 직접 읽는다(그 시점엔 `ConfigModule.forRoot()`가 `.env`를 이미 올렸다). JWT 시크릿은 `auth/jwt-secret.ts`의 `JWT_SECRET` provider 하나를 JwtModule과 AuthService가 함께 쓴다.

## 상태와 SQL

- **바운티 상태 문자열 배열을 직접 만들지 않는다.** `bounties/bounty-status.ts`의 `BountyStatusPolicy`를 쓴다. 공개 노출 조건은 `publicBountySql()`(`opened_at IS NOT NULL`)이다 - 상태 목록으로 거르지 않는다 (정적 가드 `status-literals.spec.ts`).
  제출물·지원서 상태도 같다 - `bounties/submission-status.ts`(`SubmissionStatusPolicy`), `bounties/application-status.ts`(`ApplicationStatusPolicy`).
  SQL의 상태 집합은 helper가 주는 배열을 `= ANY($n::text[])`로 바인딩한다. `src/test-support/status-literals.spec.ts`가 상태 리터럴 집합(`['APPROVED', 'REJECTED']`, `IN ('SUBMITTED', …)`)을 막는다.
  payout 상태 집합과 배정 상한식 `LEAST(amount, deposited_amount)`도 같다 - `rewards/payout-status.ts`의 상수/헬퍼(`OPEN_PAYOUT_STATUSES`, `allocatedPayoutSumSql()`, `rewardCapSql()` 등)를 쓰고,
  다른 쿼리에 끼워 넣는 조각은 `sqlStatusList()`로 렌더링한다. `scripts/record-refund.js`·`scripts/mainnet-preflight.sql`의 사본은 `payout-status.spec.ts`가 대조한다.
- **자주 쓰는 SQL 조건은 조각 함수로 끼운다**: 활성 유저 `activeUserSql()`(`users/active-user.ts`), 연결된 대표 지갑 `primaryWalletSql()`(`wallets/primary-wallet.ts`), 유저가 소유한 에이전트 id `ownedAgentIdsSql($n, 'live' | 'including-deleted')`와 참여 행의 사람 `participantUserIdSql()`(`agents/owned-agents.ts`). 사본을 새로 쓰면 `common/database/sql-predicates.spec.ts`가 실패한다. 공개 집계의 완료된 수상·완료된 바운티는 `completedWinSql()`/`completedBountySql()`(`bounties/completed-wins.ts`), "지급 요청 가능"은 `payoutRequestableSql()`(`rewards/payout-status.ts`, `requestPayout`의 명령형 검사와 db-spec으로 대조). 탈퇴 여부만 보는 `deleted_at IS NULL`처럼 의도적으로 다른 조건은 각 파일 주석에 적었다.
- **SQL에서 같은 `$n`을 두 번 쓰면 캐스트도 같게 쓴다** (`$6::varchar` … `$6::varchar`). 한쪽만 bare/캐스트면 Postgres가 `42P08 inconsistent types deduced for parameter`로 거부한다 -
  mock DB 유닛 테스트는 이를 잡지 못하므로 새 SQL 흐름은 `src/test-db`에 실 DB 테스트를 추가한다.
- **유니크 충돌 판별은 `isUniqueViolation(err)`** (`common/database/pg-errors.ts`).

## API 계약 산출물 (`contract/`)

- **DTO·에러 코드·FE용 상수를 추가하거나 바꾸면 `npm run contract:export`로 `contract/*.json`을 다시 생성해 같은 PR에 커밋한다** (CI verify 잡이 재생성 후 diff가 있으면 실패). 생성물은 손으로 고치지 않는다. `@nestjs/swagger`는 devDependency이고 계약 전용 컴파일에서만 쓰므로 런타임 코드에 `@nestjs/swagger` import·`@ApiProperty`를 넣지 않는다(운영 의존성이 되고, `required` 키는 필수 필드를 선택으로 뒤집는다). DTO를 `.dto.ts`/`.controller.ts`/`cohort-fields.ts` 밖의 파일에 새로 두면 `scripts/contract-export.js`의 `DTO_FILE_SUFFIXES`에 추가한다(빠지면 생성기가 멈춘다).

## 에러 코드, 감사 로그, 운영 알림

- **에러 코드는 `common/http/error-codes.ts` 카탈로그에 등록한다** (코드 → HTTP 상태 → 한 줄 의미). 서비스에는 `throw new XxxException('NEW_CODE')` 리터럴로 던지고, 카탈로그와 `docs/api-contract.md` "에러 코드" 표에 같은 행을 추가한다 - 빠지면 `src/test-support/error-codes.spec.ts`가 실패한다.
- **감사 로그는 `AuditService`로만 남긴다** - 사람/시스템 행위는 `record()`, Agent API 키로 한 행위(유저 id 없음)는 `recordAgentAction()`(`actor_agent_id`). 트랜잭션 안이면 `tx`를 넘긴다.
  action은 `audit/audit-actions.ts` 카탈로그(`AUDIT_ACTIONS`, entity_type까지 타입으로 묶임)의 키만 받는다. 새 action은 카탈로그와 `docs/api-contract.md` "감사 action 카탈로그" 표에 같이 추가한다(`audit/audit-actions.spec.ts`). 이미 쌓인 값은 이름을 바꾸지 않는다.
- **운영 알림은 `AlertService.notify(key, message)`로만 보낸다** (`common/alerts/alert.service.ts`, 전역 모듈). 절대 throw하지 않으므로 try/catch 불필요.
  `key`는 고정 문자열(또는 `종류:작은 고정 집합` - 예 `nft-job-failed:MINT_CHILD`)이고 같은 키는 30분에 한 번만 나간다(웹훅 전달 성공 기준 - 실패는 2초 뒤 1회 재시도 후 다음 발생이 다시 시도). 메시지에 비밀·PII(이메일, 닉네임, 요청 본문, 실제 경로 값)를 넣지 않는다 - id·개수·상태·라우트 패턴만.

## HTTP 공통 동작

### 요청 ID (`X-Request-Id`)

`configureApp()`의 첫 미들웨어(`src/common/http/request-id.ts`)가 모든 응답에 `X-Request-Id`를 붙인다. 들어온 헤더가 `^[A-Za-z0-9._-]{8,64}$`이면 그대로 쓰고,
아니면(없음·형식 오류·CR/LF 포함·중복 헤더) `randomUUID()`로 새로 만든다. CORS `exposedHeaders`에 포함돼 브라우저 FE가 읽을 수 있다.
요청 로그 줄(`HTTP`)과 5xx 줄(`HttpException`) 끝에 ` rid=<id>`가 붙어, 장애 시 사용자가 알려준 ID로 두 줄을 묶어 찾는다. 응답 본문과 5xx 버스트 알림 본문은 바뀌지 않는다.

### 세션: refresh 토큰 HttpOnly 쿠키 (`X-Ninja-Session: cookie`)

FE는 `/api/auth/*`를 Next.js rewrite로 이 서버의 `/auth/*`에 프록시하고, 요청에 `X-Ninja-Session: cookie`를 붙여 쿠키 모드를 켠다.
그때 `/auth/exchange`·`/auth/refresh`는 refresh 토큰을 `Set-Cookie: ninja_rt=…; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=<JWT_REFRESH_TTL 초>`(Domain 없음)로만 주고
본문에서 뺀다(`{accessToken}`), `/auth/refresh`는 쿠키를 읽고(본문 `{}`), `/auth/logout`은 쿠키를 지운다(`Max-Age=0`). 헤더가 없으면 쿠키는 무시되고 기존 본문 모드(deprecated)다 - 커스텀 헤더가 CSRF 방어선.
쿠키는 의존성 없이 `common/http/cookies.ts`로 읽는다. `/auth/refresh`·`/auth/exchange` 한도는 IP가 아니라 제시된 토큰/코드의 해시별 10/min(`auth/auth-throttler.guard.ts`) + IP당 600/min(이 두 라우트만 전역 120/min을 올림 - Vercel rewrite 뒤 사용자들이 소수의 egress IP를 공유, `docs/security.md`). 계약 전문: `docs/api-contract.md` "refresh 쿠키 모드", 보안 모델: `docs/security.md`.
로컬에서 `Secure` 쿠키는 `http://localhost`에서도 브라우저가 받는다(localhost는 secure context).
