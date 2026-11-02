# NinjaLabs Backend

Injective 생태계 빌더 커뮤니티 & 바운티 마켓플레이스의 백엔드. 프론트엔드는 [NinjaLabsFE](https://github.com/NinjaLabs-Korea/NinjaLabsFE).

빌더가 바운티를 완료하면 보상을 받고, 완료 기록은 온체인 NFT로 남는다. 이 서버는 로그인과 온보딩, 지갑 연결, 바운티 지원·제출·심사, 보상 입금과 지급, NFT 발행, 커뮤니티(멤버, 공지, 명예의 전당, 기수 모집), AI 에이전트 API, 운영자 콘솔 API를 맡는다.

| | |
|---|---|
| 스택 | NestJS 11 · TypeScript 5.9 · PostgreSQL (Supabase) · raw SQL (`pg`) · CW-721 Nestable NFT (Injective) |
| 런타임 | Node 22 이상 · npm |
| 배포 | `main` 머지 = Railway 운영 배포 (마이그레이션이 먼저 돈다) |
| 스키마 | `supabase/migrations/*.sql`이 유일한 출처. 모든 테이블 RLS on |

## 빠르게 시작하기

새 수령 지갑 교체만 기본 OFF다. 호환 배포·구버전 드레인 후 `WALLET_REPLACEMENT_ENABLED=true`로 켠다.
기존 NFT 자동 발급은 새 설정 없이 유지된다(기존 체인 설정/자격 증명 필요).
중지할 때만 `NFT_MINTING_ENABLED=false`로 설정한다. 복원 전에는 반드시 명시적으로 중지·드레인하고 체인 대조 후 재개한다.
상세 순서는 [운영 반영 체크리스트](docs/wallet-replacement-release.md)를 따른다.

```bash
npm install
cp .env.example .env        # DATABASE_URL 등 채우기
npm run migrate             # supabase/migrations를 순서대로 적용
npm run start:dev           # http://localhost:4000
```

로컬 FE(`http://localhost:3000`)는 `.env` 기본값 그대로 이 서버에 붙는다. 다른 포트를 쓰거나 운영 BE에 붙이고 싶다면 [docs/deployment.md](docs/deployment.md) "로컬 오리진"을 본다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `npm run start:dev` | 개발 서버 (watch) |
| `npm run migrate` | 마이그레이션 적용 (`scripts/migrate.js`, Supabase CLI 불필요) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | 단위 테스트 + 정적 가드 (DB mock) |
| `npm run test:db` | 실제 Postgres 통합 테스트 (`TEST_DATABASE_URL` 필요) |
| `npm run test:e2e` | 앱 전체를 띄운 HTTP e2e (`TEST_DATABASE_URL` 필요) |
| `npm run test:mutation` | 돈 경로 뮤테이션 테스트 (수동, CI 아님) |
| `npm run build` | 프로덕션 빌드 |
| `npm run contract:export` | API 계약 산출물 `contract/*.json` 재생성 (OpenAPI 요청 스키마, 에러 코드, 상수. DB·env 불필요, CI가 최신인지 검사) |

**PR 전 체크** (CI와 같다): `npm run lint && npm run typecheck && npm test && npm run build && npm run contract:export`(그 뒤 `contract/`에 diff가 없어야 한다), Postgres가 있으면 `npm run test:db`와 `npm run test:e2e`까지. 자세한 내용은 [docs/testing.md](docs/testing.md).

## 코드 구조

### 도메인 모듈 (`src/`)

| 모듈 | 하는 일 |
|---|---|
| `auth/` | 구글 OAuth → JWT 세션 (refresh는 HttpOnly 쿠키), `AuthGuard` / `AdminGuard` |
| `users/` | 온보딩 프로필, 닉네임 중복 검사, 공개 프로필, 프로필 사진 (`user-avatar.service`), 회원 탈퇴 (`account-withdrawal.service`) |
| `wallets/` | 지갑 연결 challenge/verify (nonce 서명) |
| `members/` | 공식 멤버 탭 (공개) + 운영자 멤버 지정 |
| `notices/` | 공지·소식 (공개 읽기, 행사 날짜 `event_date`) + 운영자 공지 관리 |
| `cohorts/` | 기수 모집: 공개 현재 기수와 지원서 질문 (`cohort-questions.ts`), 지원서 제출·수정·철회, 운영자 기수 관리·질문 편집·심사·CSV |
| `highlights/` | 명예의 전당 큐레이션 + 자동 집계 지표 + 운영자 관리 |
| `media/` | 이미지 저장 (운영자 업로드, 프로필 사진) + 공개 immutable 조회 `/media/<id>` |
| `bounties/` | 바운티 목록·상세, 지원(applications), 제출(submissions, 리비전), `admin/`에 운영자 관리와 전이 차단 사유 |
| `rewards/` | 선입금 확인 → payout 멱등 지급 (운영자 API 포함) |
| `nfts/` | 부모·자식 NFT + `nft_job` 비동기 워커 (1분 폴링) + 운영자 잡 콘솔 (목록, 재시도) |
| `agents/` | AI 에이전트 등록·검증·API 키 + Agent API 인증 ([docs/agent-api.md](docs/agent-api.md)) |
| `audit/` | 감사 로그 기록 (`AuditService`) + 조회 |
| `health/` | `GET /health` (DB 연결 확인) |

상태 규칙은 파일 하나에만 둔다. 상태 목록을 새로 만들지 말고 아래를 쓴다.

| 파일 | 담당 |
|---|---|
| `bounties/bounty-status.ts` | 바운티 상태 집합, 전이표, 공개 노출 조건 (`publicBountySql`) |
| `bounties/submission-status.ts` | 제출물 상태, 심사 결정표, 코멘트 필수 규칙 |
| `bounties/application-status.ts` | 지원서 상태, 심사 결정, 재지원 규칙 |
| `rewards/payout-status.ts` | payout 상태 집합, 배정 상한식, 제출별 지급 상태 SQL |

FE가 알아야 하는 상수(상태 집합, 전이표, 카테고리·역할 등)를 새로 만들거나 바꾸면 `scripts/contract-export.js`의 `buildConstants()`에 넣고 `npm run contract:export`로 `contract/`를 다시 생성해 같이 커밋한다.

### 공통 인프라 (`src/common/` 외)

| 위치 | 하는 일 |
|---|---|
| `common/database/` | `pg` Pool 기반 `DatabaseService` (query + tx, 연결·문장 타임아웃) + `SchemaGuard` (미적용 마이그레이션이 있으면 기동 거부) |
| `common/http/` | 요청 ID, 쿠키, 전역 예외 필터, 요청 로깅, 에러 코드 카탈로그 (`error-codes.ts`) |
| `common/validation/` | DTO 공용 검증기 (trim, URL, tx hash, 토큰 금액, 글자 수) |
| `common/throttler/` | rate limit (memory 또는 postgres 저장소, 공개 읽기 한도) |
| `common/alerts/` | 운영 알림 `AlertService` (웹훅, 없으면 로그만) + 기동 실패 알림 + 5xx 버스트 감지 |
| `common/maintenance/` | 만료 데이터 정리 크론 |
| `common/crypto/` | 지갑 서명 검증 (EIP-191 / ADR-36) |
| `common/logging/` | 로그에 비밀이 새지 않게 하는 헬퍼 |
| `app-setup.ts` | `configureApp()`: 전역 파이프·필터·인터셉터·CORS·trust proxy. `main.ts`와 e2e가 같이 쓴다 |
| `deploy/` | 배포 설정 가드 스펙 (`railway-config`, `audit-gate`). 런타임 코드 없음 |
| `test-support/` | 단위 스펙 공용 헬퍼 (`createMockDb` 등) + 정적 가드 스펙 |
| `test-db/`, `test-e2e/` | 실 DB 통합 테스트, HTTP e2e |

### 운영 스크립트 (`scripts/`)

운영 데이터를 고치는 스크립트(`grant-admin`, `requeue-nft-jobs`, `forfeit-award`, `record-refund`)는 `--dry-run`과 확인 프롬프트가 있고 감사 행을 남긴다. 사용법은 [docs/runbook.md](docs/runbook.md).

| 스크립트 | 하는 일 | 런북 |
|---|---|---|
| `migrate.js` | 마이그레이션 러너 (advisory lock으로 직렬화, 실패 시 운영 알림) | §2 |
| `grant-admin.js` | 운영자 권한 부여·회수 | §3 |
| `requeue-nft-jobs.js` | 실패한 `nft_job` 수동 재시도 | §7.3 |
| `forfeit-award.js` | 지급할 수 없는 수상의 보상 미지급 처리 | §7.4 |
| `record-refund.js` | 취소 바운티의 환불 기록 | §7.7 |
| `mainnet-preflight.sql` | 메인넷 전환 전 읽기 전용 점검 (psql) | §8 |
| `find-static-ext-nicknames.sql` | 정적 파일 확장자로 끝나는 기존 닉네임 목록 (읽기 전용) | §2 |
| `seed-perf.sql`, `perf/` | 로컬 부하 점검용 시드와 부하 드라이버 (운영에 쓰지 않는다) | §10 |
| `audit-gate.js` | CI의 `npm audit` 게이트 (`audit-allowlist.json`) | |
| `contract-export.js` | `npm run contract:export`: API 계약 산출물 `contract/*.json` 생성 (운영 데이터 무관) | |
| `ops-cli.js`, `ops-alert.js` | 스크립트 공용 접속·인자·프롬프트, 웹훅 전송 | |

## 꼭 지킬 규칙

전문과 예외는 [docs/conventions.md](docs/conventions.md). 대부분 정적 가드 스펙이 지키므로 어기면 `npm test`가 실패한다.

- **운영자 API는 도메인 모듈 안에** `*-admin.controller.ts` / `*-admin.service.ts`로 두고 `@UseGuards(AdminGuard)`를 붙인다.
- **상태 목록을 직접 쓰지 않는다.** 위 상태 파일의 상수와 SQL 헬퍼를 쓴다.
- **자주 쓰는 SQL 조건은 조각 함수로** 끼운다: 활성 유저, 대표 지갑, 소유 에이전트, 완료된 수상 등.
- **SQL의 같은 `$n`은 캐스트도 같게** 쓴다. 다르면 Postgres가 `42P08`로 거부하는데 mock 테스트는 못 잡는다.
- **에러 코드는 카탈로그에 등록**한다: `common/http/error-codes.ts`와 `docs/api-contract.md` "에러 코드" 표에 같은 행.
- **감사 로그는 `AuditService`로만**, action은 `audit/audit-actions.ts` 카탈로그의 키만. 이미 쌓인 action 이름은 바꾸지 않는다.
- **운영 알림은 `AlertService.notify()`로만**, 메시지에 비밀과 개인정보를 넣지 않는다.
- **`process.env`를 직접 읽지 않고** `ConfigService`를 주입받는다.
- **새 전역 파이프·필터·미들웨어는 `configureApp()`에** 넣는다. 그래야 e2e가 검증한다.

## 배포

`main`에 머지하면 Railway가 `npm run migrate`를 먼저 돌리고 그다음 새 코드를 띄운다. 마이그레이션이 빠진 채 올라오면 `SchemaGuard`가 기동을 거부한다. production에 필요한 env와 기동 거부 조건은 [docs/deployment.md](docs/deployment.md), 첫 배포 순서와 장애 대응은 [docs/runbook.md](docs/runbook.md).

## 문서

| 문서 | 내용 |
|---|---|
| [docs/conventions.md](docs/conventions.md) | 코드 규칙 전문, 요청 ID, refresh 쿠키 |
| [docs/testing.md](docs/testing.md) | 테스트 계층, 실 DB와 e2e 하네스, 뮤테이션 테스트 |
| [docs/deployment.md](docs/deployment.md) | 배포 순서, production env 표, 로컬 오리진 |
| [docs/api-contract.md](docs/api-contract.md) | REST API 계약, 에러 코드, 감사 action 카탈로그 (FE `docs/auth-api-contract.md`와 짝) |
| [docs/agent-api.md](docs/agent-api.md) | AI 에이전트용 Agent API v1 |
| [docs/security.md](docs/security.md) | 보안 체크리스트와 보안 모델 |
| [docs/decisions.md](docs/decisions.md) | 제품 결정과 MVP 기본값 |
| [docs/runbook.md](docs/runbook.md) | 운영 런북: 첫 배포, 어드민 부트스트랩, 백업·복구, 장애 플레이북, 메인넷 전환, 멀티시그 |
