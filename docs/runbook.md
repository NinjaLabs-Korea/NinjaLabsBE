# 운영 런북

> 대상: 운영자(어드민 권한 + Railway/Supabase/Google Cloud 접근 권한자).
> 이 문서는 "무엇을 어떤 순서로 누르고 실행하는가"만 다룬다. 이유와 보안 모델은 [security.md](security.md), 제품 결정은 [decisions.md](decisions.md), API 모양은 [api-contract.md](api-contract.md).
> 명령은 BE 레포 루트에서 실행한다. 운영 DB에 붙는 명령은 `railway run <cmd>`(로컬에서 Railway 서비스 변수를 주입해 실행) 또는 셸에 `DATABASE_URL`/`DATABASE_CA_CERT`를 직접 넣고 실행한다.

목차
1. [첫 배포 순서와 env 체크리스트](#1-첫-배포-순서와-env-체크리스트)
2. [운영 스크립트](#2-운영-스크립트)
3. [어드민 부트스트랩](#3-어드민-부트스트랩)
4. [Google OAuth 동의 화면 프로덕션 게시](#4-google-oauth-동의-화면-프로덕션-게시)
5. [백업과 복구 리허설 (Supabase)](#5-백업과-복구-리허설-supabase)
6. [업타임 모니터 (GET /health)](#6-업타임-모니터-get-health)
7. [장애 대응 플레이북](#7-장애-대응-플레이북)
8. [testnet → mainnet 전환](#8-testnet--mainnet-전환)
9. [멀티시그 서명자 문서 템플릿](#9-멀티시그-서명자-문서-템플릿)

---

## 1. 첫 배포 순서와 env 체크리스트

근거: README "배포 순서 (Railway)", "이 브랜치 첫 배포 전에 있어야 하는 env". 순서는 **스키마 → BE → FE** — 새 BE는 새 스키마를, 새 FE는 새 BE 라우트를 전제한다.

1. **Supabase 프로젝트** 준비 — `Project Settings → Database`에서 접속 문자열(direct 5432 또는 Supavisor session 모드)과 CA 인증서(`SSL Configuration → Download certificate`)를 받는다. Pro 플랜 이상이면 백업 설정을 바로 확인한다(§5).
2. **Railway 서비스 설정 반영** — `.railway/railway.ts`는 적혀 있을 뿐이다. `railway config plan` → `railway config apply`로 `preDeploy: npm run migrate`, healthcheck `/health`, 공개 env를 서비스에 적용한다. 적용 전 배포는 마이그레이션이 자동으로 돌지 않아 SchemaGuard가 `MIGRATIONS_PENDING`으로 크래시 루프를 만든다.
   **주의 — IaC는 선언형이다**: `railway.ts`에 없는 변수를 대시보드에서만 넣으면, 이후 `railway config plan`이 그 변수를 **삭제 대상**으로 보여 줄 수 있다. 코드가 읽는 키는 전부 `railway.ts`에 값 또는 `preserve()`로 선언돼 있다 — 비밀/주소(`DATABASE_URL`, `DATABASE_CA_CERT`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, `MASTER_WALLET_MNEMONIC`, `OPS_ALERT_WEBHOOK_URL`, `TURNSTILE_SECRET_KEY`, `REWARD_MULTISIG_ADDRESS`, §8의 `INJECTIVE_GRPC_ENDPOINT`)와 선택 스위치(`PAYOUT_ALLOW_SELF_APPROVAL`, `LEGACY_ACCESS_TOKEN_CUTOFF`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`)는 `preserve()`. 의도적으로 빠진 키는 `PORT`·`RAILWAY_ENVIRONMENT_NAME`(Railway 주입), `PGSSLMODE`(로컬 전용), `AUTH_ALLOWED_REDIRECT_ORIGINS`(두 번째 FE 오리진이 생기면 공개값으로 추가)뿐이고 `src/deploy/railway-config.spec.ts`가 이 대응을 검사한다. 그래도 매번 plan 출력에서 변수 삭제 줄을 확인하고, 보이면 apply하지 말고 그 키를 `railway.ts`에 `preserve()`로 추가하는 PR을 먼저 머지한다. 변수 삭제를 허용하는 `--confirm-destructive`는 쓰지 않는다.
3. **비밀 env 입력** (Railway 대시보드 → Variables, 첫 컨테이너가 뜨기 **전에**):

   | env | 확인 | 빠지면 |
   |---|---|---|
   | `DATABASE_URL` | Supabase 접속 문자열 | preDeploy migrate 실패 → 배포 중단(구 버전 유지) |
   | `DATABASE_CA_CERT` | Supabase CA PEM(`\n` 이스케이프 가능) | 기동 + `warn` 1회, TLS 미검증 — **운영 전 필수로 넣는다** |
   | `JWT_SECRET` | `openssl rand -base64 48` | 미설정/자리표시값 → 기동 거부. 32바이트 미만 → `error` 로그 |
   | `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth 클라이언트 | 기동 거부 |
   | `MASTER_WALLET_MNEMONIC` | 민팅 전용 지갑 (§7.6) | 민팅 잡이 1시간씩 미뤄짐(`not configured`) |
   | `REWARD_MULTISIG_ADDRESS` | 멀티시그 주소 (§9) | **새 보상의 `custody_address`가 `PENDING_MULTISIG_SETUP`** — 스폰서가 입금할 곳이 없다. `railway.ts`는 `preserve()` 자리만 잡으므로 값은 대시보드/CLI로 넣는다 |
   | `PAYOUT_ALLOW_SELF_APPROVAL` | 넣지 않는다(기본 false, 2인 승인) | 운영자 1인일 때만 `true` |
   | `LEGACY_ACCESS_TOKEN_CUTOFF` | 선택 | 미설정이면 프로세스 시작 시각 |
   | `OPS_ALERT_WEBHOOK_URL` | 운영 채널 Discord/Slack incoming webhook (https, `railway.ts` `preserve()`) | 알림이 `OpsAlert` warn 로그로만 남아 아무도 못 본다 (README env 표, security.md "운영 알림") |
   | `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 시크릿 (`railway.ts` `preserve()`) — **FE `NEXT_PUBLIC_TURNSTILE_SITE_KEY` 배포 뒤** 넣는다 | 로그인 봇 방지 생략 + production 기동 시 `warn`. 순서가 바뀌면 모든 로그인이 400 `TURNSTILE_FAILED` |

   공개 값(`NODE_ENV=production`, `TRUST_PROXY=1`, `THROTTLER_STORAGE=postgres`(레플리카 간 공유 rate limit — 0016), `CORS_ORIGINS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CALLBACK_URL`, `AUTH_SUCCESS_REDIRECT`, `INJECTIVE_*`, `NFT_CONTRACT_ADDRESS`, `USDC_EVM_CONTRACT_ADDRESS`)은 `railway.ts`가 넣는다. 수동 배포라면 `NODE_ENV=production`이 빠지지 않았는지 본다 — 빠지면 기동 검사가 전부 꺼진다.
4. **BE 배포** — `main` 머지 → Railway가 `npm run migrate` 후 새 컨테이너 기동. 로그에서 `apply 00xx_…`/`skip`, 그리고 `warn`/`error` 줄(특히 `DATABASE_CA_CERT`, `TRUST_PROXY`, `JWT_SECRET`)을 확인한다. `curl -fsS https://<BE>/health` → `{"status":"ok","db":"up"}`.
5. **Google OAuth** — 승인된 리디렉션 URI가 `GOOGLE_CALLBACK_URL`과 정확히 같은지, 동의 화면이 "In production"인지(§4).
6. **FE 배포** — FE `develop` 머지(preview 확인) → 릴리스 PR `develop → main`(Vercel prod). FE `.env.production`의 `NINJA_API_BASE_URL`이 BE 주소, chain ID와 RPC URL이 같은 네트워크인지.
7. **어드민 부트스트랩** (§3) → 운영자 로그인 → `/admin` 접근 확인.
8. **업타임 모니터** 등록 (§6). 첫 백업이 생성됐는지 확인 (§5).

### 배포 중 종료 순서

재배포 때 Railway는 새 컨테이너가 healthy가 된 뒤 옛 컨테이너에 SIGTERM을 보내고, `drainingSeconds`(30초, `.railway/railway.ts`)가 지나면 SIGKILL한다. 옛 컨테이너는 그 사이에 다음 순서로 닫힌다 (`app.enableShutdownHooks()`, Nest `close()`):

1. `beforeApplicationShutdown` — 크론 정지. `NftJobWorker`·`MaintenanceService`·`PayoutWorker`는 새 실행을 건너뛰고 진행 중인 실행을 **최대 20초** 기다린다(`common/lifecycle/single-flight-task.ts`). NFT 워커는 진행 중인 잡 하나만 끝내고 배치의 나머지를 `PENDING`으로 돌려놓는다 — 로그 `shutdown: released N unstarted nft_job(s) back to PENDING`. 이 동안 HTTP는 계속 응답한다.
2. HTTP 서버 종료 — 새 연결을 받지 않고 진행 중인 요청은 끝까지 처리한다.
3. `onApplicationShutdown` — DB 풀 종료(`DatabaseService`). 풀은 항상 마지막이다.

확인할 것:
- 로그에 `Cannot use a pool after calling end on the pool`이 보이면 종료 순서가 깨진 것이다(풀을 먼저 닫는 훅이 생겼는지 본다 — `database.service.spec.ts`가 막는다).
- `shutdown: nft_job batch still running after 20s` warn은 체인 호출이 20초 넘게 걸린 경우다. 그 잡은 `PROCESSING`에 남았다가 15분 뒤 고아 재큐잉되고 `nft-job-stale-requeue` 알림이 한 번 울린다 — 배포 시각과 겹치면 조치 불필요(§7.3).
- 잡 하나의 `execute()`는 3분 기한이 있다. 넘기면 `nft_job execution timed out after 180s (chain call hung?)`로 일반 실패(10분 뒤 재시도) 처리되고, 늦게 착지한 mint는 다음 시도의 `tokenExists`가 복구한다. 반복되면 gRPC 노드를 의심한다(§7.3 "RPC/gRPC 타임아웃").
- `drainingSeconds`를 줄일 때는 20초 드레인 + HTTP 드레인보다 크게 둔다(`src/deploy/railway-config.spec.ts`가 25초 이상을 강제한다).

## 2. 운영 스크립트

모두 `scripts/migrate.js`와 같은 접속 규칙(`DATABASE_URL`, `DATABASE_CA_CERT`가 있으면 인증서 검증, 로컬은 `PGSSLMODE=disable`)을 쓴다 (`scripts/ops-cli.js`). 레포 루트 `.env`도 읽지만 셸 값이 우선한다.
**항상 `--dry-run`으로 먼저 보고**, 그다음 확인 프롬프트(정확히 `yes` 입력)로 실행한다. 비대화형(파이프/CI)에서는 프롬프트가 무조건 "no"이므로 `--yes`를 명시해야 쓴다. 모르는 플래그(`--dry-rn` 같은 오타)는 아무것도 하지 않고 종료 코드 2.

| 스크립트 | 용도 | 쓰는 것 |
|---|---|---|
| `node scripts/grant-admin.js grant\|revoke <email> [--dry-run] [--yes] [--force]` | `is_admin` 부여/회수 | `"user".is_admin` + `audit_log`(`ADMIN_GRANTED`/`ADMIN_REVOKED`, actor NULL, before/after `{is_admin}`) 한 트랜잭션 |
| `node scripts/requeue-nft-jobs.js <job-id>... \| --all [--dry-run] [--yes]` | FAILED `nft_job` 수동 재시도 | 잡 → PENDING(`retry_count` 0, 즉시), nft FAILED → `MINTED`(token_id 있음)/`PENDING`, `audit_log` `NFT_JOB_REQUEUED` |
| `node scripts/record-refund.js <reward-id> --tx <hash> [--dry-run] [--yes]` | 취소된 바운티의 환불 송금 기록 — 입금액 − PAID 잔액, `PAID` 보상 포함 (§7.7) | 보상 → `REFUNDED`, `audit_log` `REWARD_REFUNDED`(actor NULL, `{txHash, refundedAmount}`) 한 트랜잭션 |
| `node scripts/forfeit-award.js <submission-id> --reason <text> --admin <admin-user-id> [--dry-run] [--yes]` | 지급할 수 없는 승인 수상 몰수 (§7.4) | 제출 `APPROVED` → `REJECTED`, `submission_review`(REJECT, `forfeited: <사유>`), `audit_log` `SUBMISSION_AWARD_FORFEITED`(actor = `--admin`, before/after + 사유) 한 트랜잭션 |
| `psql "$DATABASE_URL" -X -f scripts/mainnet-preflight.sql [-v …]` | 메인넷 전환 전 점검 | 없음 — READ ONLY 트랜잭션 + ROLLBACK |
| `psql "$DATABASE_URL" -X -f scripts/find-static-ext-nicknames.sql` | 정적 파일 확장자로 끝나는 기존 ACTIVE 닉네임 목록 (아래) | 없음 — READ ONLY 트랜잭션 + ROLLBACK |
| `npm run migrate` | 마이그레이션 적용 (아래 "트랜잭션 제어문 거부") | `_migrations` |

종료 코드: 0 성공·변경 없음·dry-run / 1 거부·중단·대상 없음 / 2 사용법 오류. 검증: `src/test-db/ops-scripts.db-spec.ts`.

### 마이그레이션 파일의 트랜잭션 제어문 거부

`npm run migrate`는 파일 하나를 `BEGIN … COMMIT` 하나로 감싼다. 그래서 파일 안에 최상위 `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK` 문이 있으면 러너가 **아무것도 실행하기 전에** 거부한다 — 모든 파일을 먼저 검사하고, 어느 파일이든 걸리면 실행 전체가 멈춘다 (DB에 붙지 않으므로 `_migrations`에도 아무것도 기록되지 않는다). 출력은 `FAIL  <file>:<line>` + 걸린 위치 전부, 종료 코드 1 (preDeploy면 배포 중단 + 운영 알림).
`--` 주석, `/* */` 주석, 문자열 리터럴, 달러 인용 본문(`DO $$ BEGIN … END $$`, 함수 본문)은 검사하지 않는다. 고치는 법: 그 줄을 지운다 — 파일 전체가 이미 한 트랜잭션이다. 트랜잭션 밖에서 돌아야 하는 문장(`CREATE INDEX CONCURRENTLY` 등)은 이 러너로 적용할 수 없다. 검증: `src/common/database/migration-guard.spec.ts`, `src/test-db/migrate-runner.db-spec.ts`.

### 닉네임 규칙 배포 전 점검 — 정적 파일 확장자

닉네임이 `.png`/`.json`/`.js` 등(`src/users/nickname.ts` `STATIC_FILE_EXTENSIONS` = FE `src/proxy.ts` matcher 목록)으로 끝나면 FE proxy가 정적 파일 요청으로 보고 접두사 없는 프로필 링크가 깨진다. 새 BE는 이런 닉네임의 저장을 400으로 거부하지만 **이미 저장된 닉네임은 바꾸지 않는다.** 이 규칙이 들어간 BE를 배포하기 **전에**:

1. 목록을 뽑는다: `railway run sh -c 'psql "$DATABASE_URL" -X -f scripts/find-static-ext-nicknames.sql'` (읽기 전용 — `id, nickname, email, created_at`).
2. 0행이면 끝. 행이 있으면 각 유저에게 이메일로 연락해 프로필 화면에서 닉네임을 바꾸도록 안내한다 (해당 유저는 프로필을 다시 저장할 때 닉네임도 바꿔야 저장된다).
3. **자동으로 이름을 바꾸지 않는다** — SQL로 `nickname`을 고치지 말 것. 유저 동의 없는 이름 변경은 공개 프로필 링크·제출 기록의 표시 이름을 예고 없이 바꾼다.
4. 배포 뒤에도 남은 유저가 있으면 같은 스크립트로 주기적으로 확인한다.

## 3. 어드민 부트스트랩

어드민 권한은 API로 줄 수 없다(권한 상승 경로를 만들지 않기 위해). 권한자는 **DB 접속 권한이 있는 사람**(Railway 프로젝트 멤버 또는 Supabase 프로젝트 owner)이며, 부여/회수는 이 스크립트로만 한다 — 직접 `UPDATE`하면 감사 행이 남지 않는다.

1. 대상자가 FE에서 **Google 로그인을 한 번** 마친다 (`"user"` 행이 생긴다. 온보딩 완료는 필요 없다).
2. 미리 보기:
   ```bash
   railway run node scripts/grant-admin.js grant ops@example.com --dry-run
   ```
   `user … status=ACTIVE is_admin=false`와 `plan is_admin false -> true`를 확인한다. `USER_NOT_FOUND`면 1번이 안 된 것(또는 탈퇴 계정), `AMBIGUOUS_EMAIL`이면 대소문자만 다른 행이 두 개 있는 데이터 이상 — 먼저 정리한다.
3. 실행: `railway run node scripts/grant-admin.js grant ops@example.com` → `yes`.
4. 반영 시점: JWT의 `adm` 클레임이 필요하므로 대상자의 **다음 토큰 갱신(최대 15분) 또는 재로그인**부터 `/admin`이 열린다.
5. 회수: `… revoke ops@example.com`. AdminGuard가 요청마다 DB를 다시 보므로 **즉시** 403 `ADMIN_ONLY`. 마지막 활성 운영자는 `--force` 없이 회수할 수 없다(`LAST_ADMIN` — `--dry-run`과 확인 프롬프트 전에 이미 알린다).
6. 기록: `GET /admin/audit-logs?entityType=user&entityId=<user id>`에 `ADMIN_GRANTED`/`ADMIN_REVOKED`(actor 비어 있음 = 스크립트)가 보인다. 누가 실행했는지는 이 표 아래 "어드민 변경 기록"에 사람이 남긴다.

> 어드민 변경 기록 (운영 레포 밖 비공개 문서에 유지 권장): 날짜 · 대상 이메일 · grant/revoke · 실행자 · 사유

## 4. Google OAuth 동의 화면 프로덕션 게시

"Testing" 상태의 앱은 테스트 사용자로 등록된 계정(최대 100명)만 로그인할 수 있다. 일반 사용자가 로그인하면 Google이 `access_denied`로 막는다.

Google Cloud Console → (프로젝트) → **Google Auth Platform**(구 "OAuth consent screen"):
1. **Branding**: 앱 이름, 사용자 지원 이메일, 앱 홈페이지(FE prod URL), 개인정보처리방침 URL, 서비스 약관 URL, **승인된 도메인**(FE 도메인과 BE 콜백 도메인의 등록 가능 도메인 — 예: `vercel.app`/`railway.app` 같은 공용 도메인은 등록할 수 없으므로 커스텀 도메인이 필요할 수 있다), 개발자 연락처.
2. **Data access**: 스코프는 `openid`, `email`만 (`auth.service.ts` `buildGoogleAuthUrl`). 둘 다 비민감 스코프라 앱 검증(verification) 심사 대상이 아니다. 스코프를 추가하면 이 판단을 다시 한다.
3. **Clients**: 웹 클라이언트의 승인된 리디렉션 URI = `GOOGLE_CALLBACK_URL` (`https://<BE>/auth/google/callback`, 정확히 일치). JavaScript 출처는 필요 없다(서버 측 코드 교환).
4. **Audience → Publish app** → "In production". 로고를 올렸거나 브랜딩 표시가 필요하면 브랜드 검증이 걸릴 수 있다(수일) — 그동안에도 로그인은 동작한다.
5. 확인: 테스트 사용자가 아닌 개인 Gmail로 로그인 → FE 온보딩까지 진행되는지.

## 5. 백업과 복구 리허설 (Supabase)

### 백업 일정
- **Supabase 자동 백업**: `Dashboard → Database → Backups`에서 플랜별 보관 기간을 확인한다(Pro 이상은 일일 백업, PITR은 별도 애드온). 플랜과 보관 기간은 바뀔 수 있으므로 **운영 시작일에 화면을 직접 확인하고 아래 표에 적는다.**
- **자체 논리 백업(필수)**: 플랫폼 백업만 믿지 않는다. 매일 1회 `pg_dump`를 별도 저장소(접근 제한된 버킷)에 보관한다 — 보관 30일, 매월 1일분은 12개월.
  ```bash
  # direct 접속(5432)으로. 트랜잭션 풀러(6543)는 pg_dump에 쓰지 않는다
  pg_dump "$DATABASE_URL" -Fc --no-owner --no-privileges --schema=public \
    -f ninjalabs-$(date -u +%Y%m%dT%H%MZ).dump
  ```
  `pg_dump`의 메이저 버전은 서버(Supabase Postgres) 이상이어야 한다 — 낮으면 `server version mismatch`로 거부된다(`pg_dump --version`으로 확인).
  앱 데이터는 전부 `public` 스키마다(`supabase/migrations`, `_migrations` 포함). 덤프에는 이메일·지갑 주소·암호화된 grace 사본이 들어 있으므로 저장소 접근은 운영자로 제한한다.

| 항목 | 값 (운영 시작 시 채움) |
|---|---|
| Supabase 플랜 / 자동 백업 보관 | |
| PITR 사용 여부 | |
| 자체 덤프 위치 / 실행 주체(cron 호스트) | |
| 마지막 복구 리허설 날짜 / 수행자 / 결과 | |

### 복구 리허설 (분기 1회 + 큰 마이그레이션 전)
목표: "백업이 있다"가 아니라 "복구해서 앱이 뜬다"를 확인한다. 운영 DB에는 아무것도 쓰지 않는다.

1. 최신 덤프를 받는다 (자체 덤프, 또는 Supabase 대시보드 백업 다운로드).
2. 스크래치 DB를 만든다 — 로컬 Postgres(운영과 같은 메이저 버전)나 임시 Supabase 프로젝트:
   ```bash
   createdb -h localhost -U postgres ninjalabs_restore
   # --schema=public 덤프에는 `CREATE SCHEMA public`이 들어 있다 — 새 DB의 빈 public을 먼저 지우지 않으면
   # --exit-on-error가 `schema "public" already exists`에서 멈춘다 (빈 스크래치 DB에만 할 것)
   psql -h localhost -U postgres -d ninjalabs_restore -c 'DROP SCHEMA public'
   pg_restore -h localhost -U postgres -d ninjalabs_restore --no-owner --no-privileges --exit-on-error ninjalabs-<ts>.dump
   ```
   `schema "extensions" does not exist` 류 오류가 나면 `CREATE SCHEMA extensions;` 후 다시 시도한다(Supabase는 확장을 `extensions` 스키마에 둔다).
3. 스키마 스모크:
   ```bash
   export RESTORE_URL=postgresql://postgres@localhost:5432/ninjalabs_restore
   psql "$RESTORE_URL" -c "SELECT name FROM _migrations ORDER BY name DESC LIMIT 1"   # = supabase/migrations 마지막 파일
   DATABASE_URL=$RESTORE_URL PGSSLMODE=disable npm run migrate                    # 전부 skip이어야 한다
   psql "$RESTORE_URL" -c "SELECT (SELECT count(*) FROM \"user\") users, (SELECT count(*) FROM bounty) bounties,
     (SELECT count(*) FROM payout) payouts, (SELECT count(*) FROM nft) nfts, (SELECT max(created_at) FROM audit_log) last_audit"
   ```
   건수를 운영 DB(같은 쿼리, 읽기 전용)와 비교한다 — 덤프 시각 이후 차이만 있어야 한다.
4. 앱 스모크 — 복구본 위에 BE를 로컬로 띄운다(`NODE_ENV=development`, `JWT_SECRET`은 임의 값, `MASTER_WALLET_MNEMONIC`은 **비운다** — 복구본에서 민팅 워커가 체인에 쓰지 않게):
   ```bash
   DATABASE_URL=$RESTORE_URL PGSSLMODE=disable MASTER_WALLET_MNEMONIC= npm run start:dev
   curl -fsS localhost:4000/health          # {"status":"ok","db":"up"} — SchemaGuard 통과 = 스키마 완전
   curl -fsS 'localhost:4000/bounties' | head -c 300
   curl -fsS 'localhost:4000/notices' | head -c 300
   curl -fsS 'localhost:4000/hall-of-fame' | head -c 300
   ```
5. 걸린 시간(다운로드 → 앱 응답)을 RTO로 기록하고 위 표를 갱신한다. 스크래치 DB를 지운다(`dropdb ninjalabs_restore`) — 개인정보 사본을 남기지 않는다.

실제 복구(운영): Supabase 대시보드 복원(같은 프로젝트를 덮어씀) 또는 새 프로젝트에 `pg_restore` 후 Railway `DATABASE_URL`/`DATABASE_CA_CERT` 교체 → 재배포. 복원 시점 이후의 온체인 사실(입금·지급 tx, 민팅)은 DB에 없으므로 §7.4의 대조 절차로 다시 맞춘다.

## 6. 업타임 모니터 (GET /health)

`GET /health`는 DB에 `SELECT 1`을 보낸다 — 정상 `200 {"status":"ok","db":"up"}`, DB 장애 시 **`503 {"status":"degraded","db":"down"}`**. 인증 없이 열려 있다(전역 스로틀 IP당 120/min 안에 있으므로 1분 간격 모니터는 문제없다).

외부 모니터(UptimeRobot, Better Stack 등 아무거나 — Railway healthcheck는 배포 시에만 보므로 별도로 둔다):
- URL `https://<BE>/health`, 메서드 GET, 간격 1분, 타임아웃 10초.
- 성공 조건: 상태 코드 200 **그리고** 본문에 `"db":"up"` 포함(키워드 모니터). 503은 "DB 다운", 연결 실패/5xx(503 외)는 "앱 다운"으로 구분해 알림 제목에 남긴다.
- 연속 2회 실패 시 알림(운영 채널 + 당번 이메일). 복구 알림도 켠다.
- 앱 내부 알림은 별도: `OPS_ALERT_WEBHOOK_URL`이 있으면 payout 48시간 미승인, nft_job FAILED, 고아 PROCESSING 재큐잉, 5분 안에 5xx 20건 초과, 기동 실패, preDeploy 마이그레이션 실패를 같은 채널로 보낸다(같은 알림 30분 쿨다운 — 전달 성공 뒤부터, 실패는 2초 뒤 1회 재시도. 인스턴스별 — security.md "운영 알림").
- FE도 하나: `https://<FE>/` 200.
- 참고: DB 장애 중에는 Railway healthcheck도 503이라 **새 배포가 healthy가 되지 않는다** — 장애 중 재배포로 고치려 하지 말 것(§7.1).

## 7. 장애 대응 플레이북

공통: 시작 시각·증상·조치·종료 시각을 운영 채널 스레드 하나에 남긴다. 사후 `audit_log`와 Railway 로그를 첨부한다. 로그에는 니모닉·토큰이 남지 않도록 되어 있지만(`logSafe`, `sanitizeError`), 붙여 넣기 전에 한 번 더 본다.

### 7.1 DB 다운 (`/health` 503)
1. Supabase status 페이지와 `Dashboard → Reports/Logs`로 원인 분류: 플랫폼 장애 / 프로젝트 일시정지(무료 플랜 비활성) / 접속 수 초과 / 디스크 가득 / 인증서·비밀번호 변경.
2. Railway 로그에서 `timeout exceeded when trying to connect`(풀 고갈 — 느린 쿼리/커넥션 누수, API는 `503 DATABASE_UNAVAILABLE`), `Connection terminated due to connection timeout`(DB 무응답 — 연결 수립 `DB_CONNECTION_TIMEOUT_MS` 초과), `canceling statement due to statement timeout`(`DB_STATEMENT_TIMEOUT_MS` 초과 쿼리 — 500), `ECONNREFUSED`, `too many connections`, `self-signed certificate`(→ `DATABASE_CA_CERT` 불일치), `password authentication failed`(→ `DATABASE_URL` 회전) 중 무엇인지 본다.
3. 원인별: 플랫폼 장애는 대기(재배포 금지 — healthcheck가 실패해 롤아웃이 멈춘다). 접속 수 초과는 Supavisor session 모드 URL로 교체 또는 인스턴스 수 축소. 자격 증명/인증서 문제는 Railway 변수 수정 → 재배포.
4. 복구 후: `/health` 200, `nft_job`의 PROCESSING 잡은 워커가 15분 뒤 스스로 PENDING으로 되돌린다(조치 불필요). 장애 중 실패한 사용자 요청은 재시도 안내.

### 7.2 Google 장애 → `GOOGLE_UNAVAILABLE`
- 증상: 사용자는 Google 동의 뒤 FE `/auth/callback#error=AUTH_FAILED`로 돌아온다 — 콜백(`GET /auth/google/callback`)은 모든 실패를 같은 리다이렉트로 감추므로(api-contract.md) **HTTP 503/401은 브라우저나 업타임 모니터에 보이지 않는다**. 원인은 Railway 로그로만 구분한다:
  - `Google id_token verification unavailable: …` (warn) 뒤 `[onboarding] {"event":"oauth.callback.failed",…,"errorCode":"GOOGLE_UNAVAILABLE"}` — Google JWKS를 못 받아 id_token 서명을 검증할 수 없음(내부적으로 503).
  - `"errorCode":"GOOGLE_CODE_EXCHANGE_FAILED"` — 토큰 엔드포인트가 비-2xx 응답(내부적으로 401). `"errorCode":"TypeError"` 등은 토큰 엔드포인트에 연결 자체가 안 된 경우.
  - `"errorCode":"INVALID_OAUTH_STATE"` — Google 문제가 아니다(state 만료·`JWT_SECRET` 교체 직후, §7.5).
- 영향: **새 로그인만** 막힌다. 이미 로그인한 사용자는 refresh 토큰(우리 DB)으로 계속 쓴다. 에이전트 API(API 키)는 무관.
- 조치: Google Cloud status 확인 → 대기. 우리 쪽에서 우회하지 않는다(서명 검증을 끄지 않는다). 공지 채널에 "로그인 일시 장애, 기존 세션은 정상" 안내.
- `GOOGLE_CODE_EXCHANGE_FAILED`가 Google 정상인데 계속 나면: `GOOGLE_CLIENT_SECRET` 회전/만료, 리디렉션 URI 불일치(§4)를 의심한다.

### 7.3 NFT 민팅 정체
1. 상태 보기:
   ```sql
   SELECT status, job_type, count(*), min(scheduled_at), max(retry_count) FROM nft_job GROUP BY 1, 2 ORDER BY 1, 2;
   SELECT id, job_type, retry_count, last_error, scheduled_at FROM nft_job
    WHERE status IN ('PENDING', 'FAILED') ORDER BY scheduled_at LIMIT 20;
   ```
2. `last_error`로 분류:
   - `NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured` → env 누락. 잡은 실패하지 않고 1시간씩 미뤄진다. env를 넣고 재배포하면 다음 폴링부터 돈다.
   - `parent NFT not minted yet — attach deferred` → 정상 대기(부모 민팅이 끝나면 자동으로 당겨진다). 부모 잡을 본다.
   - 가스 부족(`insufficient funds`) → 마스터 지갑 주소에 INJ 충전.
   - RPC/gRPC 타임아웃 → `INJECTIVE_GRPC_ENDPOINT`를 다른 노드로 바꾸고 재배포.
   - 컨트랙트 거부(권한/중복 token_id) → 마스터 지갑이 컨트랙트 minter인지 확인. 중복은 워커가 `tokenExists`로 자동 복구한다.
   - 15분 넘게 PROCESSING → 워커가 스스로 되돌린다. 배포 직후 한 번이면 종료 드레인 20초를 넘긴 잡이다(§1 "배포 중 종료 순서"). 계속 반복되면 인스턴스 크래시를 의심(Railway 로그).
   - `nft_job execution timed out after 180s` → 체인 호출이 멈췄다. 일반 실패로 재시도되며, 반복되면 RPC/gRPC 타임아웃과 같이 노드를 바꾼다.
3. 원인을 고친 **뒤** FAILED 잡을 재시도(고치기 전에 돌리면 같은 이유로 5회 더 실패). 한두 건이면 운영 콘솔 FE `/admin/nft-jobs`의 재시도(`POST /admin/nft-jobs/:id/retry`, 감사 `NFT_JOB_RETRIED`)로 충분하다. 여러 건/콘솔 접근 불가 시 스크립트:
   ```bash
   railway run node scripts/requeue-nft-jobs.js --all --dry-run
   railway run node scripts/requeue-nft-jobs.js --all            # 또는 <job-id> ...
   ```
4. 다음 1분 폴링 뒤 1번 쿼리로 SUCCEEDED 전환을 확인한다.

### 7.4 지급(payout) 분쟁 — "보상을 못 받았다 / 금액이 틀리다"
1. 사실 수집 (읽기만):
   - `GET /admin/bounties/:id/operations` — 제출·보상·payout 행(상태, 금액은 최소 단위 정수 문자열, 수령 지갑 주소).
   - `GET /admin/audit-logs?entityType=payout&entityId=<payout id>` — `PAYOUT_REQUESTED`/`PAYOUT_APPROVED`(또는 `PAYOUT_SELF_APPROVED`)/`PAYOUT_PAID`와 각 actor.
   - 체인 익스플로러에서 `payout_tx_hash`: 받는 주소 = payout 행의 수령 지갑, 금액 = `amount`(USDC는 10^6, INJ는 10^18 단위) 인지.
2. 판정:
   - tx가 맞는 주소·금액으로 성공 → 지급 완료. 증거(tx 링크)를 회신한다.
   - payout이 `REQUESTED`/`AWAITING_MULTISIG_APPROVAL`에 머묾 → 멀티시그 서명 대기(§9 서명자에게 요청). 48시간 넘으면 `PayoutWorker`가 warn을 남긴다.
   - 금액이 잘못 **기록만** 됐고 아직 송금 전(`REQUESTED`/`AWAITING_MULTISIG_APPROVAL`/`APPROVED`) → 현재 API에 payout 정정·취소가 없고, **취소 후 다시 요청할 수도 없다** — `POST /admin/payouts`는 같은 (보상, 제출물)에 payout 행이 하나라도 있으면 상태와 무관하게 409 `PAYOUT_ALREADY_REQUESTED`(멱등 키 `submission:<제출물>:reward:<보상>`도 유니크). 그래서 **같은 행을 정정**한다. 두 운영자 합의 후, 감사 행을 같은 트랜잭션에 남긴다. 승인은 초기화되어 2인 승인(`POST /admin/payouts/:id/approve`)을 다시 받는다 — 이미 모은 온체인 서명이 있으면 그 멀티시그 tx는 폐기한다:
     ```sql
     BEGIN;
     -- 1) 배정 상한 확인 (requestPayout과 같은 규칙): others + 정정 금액 ≤ cap 이어야 한다
     SELECT p.status, p.amount::text AS current_amount, LEAST(r.amount, r.deposited_amount)::text AS cap,
            (SELECT COALESCE(SUM(o.amount), 0) FROM payout o
              WHERE o.bounty_reward_id = r.id AND o.status <> 'CANCELLED' AND o.id <> p.id)::text AS others
       FROM payout p JOIN bounty_reward r ON r.id = p.bounty_reward_id
      WHERE p.id = '<payout id>'
        FOR UPDATE OF p, r;
     -- 2) 정정 — 결과가 UPDATE 1이어야 한다. 0이면 이미 송금 중/완료: ROLLBACK
     UPDATE payout SET amount = <정정 금액>, status = 'REQUESTED', approved_by = NULL, approved_at = NULL, last_error = '<사유>'
      WHERE id = '<payout id>' AND status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED');
     INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
     VALUES (NULL, 'PAYOUT_CORRECTED_MANUAL', 'payout', '<payout id>',
             '{"amount": "<이전 금액>"}', '{"amount": "<정정 금액>", "by": "<운영자 2인>", "reason": "<사유>"}');
     COMMIT;
     ```
     `<정정 금액>`은 토큰 최소 단위 정수(USDC 10^6, INJ 10^18)다.
   - 수상 자체를 **취소**(이 제출물에는 지급하지 않음, 송금 전) → 아래로 닫는다. 위 이유로 이 제출물에는 API로 다시 payout을 만들 수 없으니 정정으로 될 일이면 정정을 쓴다. 마지막 문장은 서비스의 `advanceRewardStatus`와 같은 재계산이다(남은 열린 payout이 없고 지급이 끝났으면 보상을 `PAID`로):
     ```sql
     BEGIN;
     UPDATE payout SET status = 'CANCELLED', last_error = '<사유>'
      WHERE id = '<payout id>' AND status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED');
     INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
     VALUES (NULL, 'PAYOUT_CANCELLED_MANUAL', 'payout', '<payout id>',
             '{"status": "<이전 상태>"}', '{"status": "CANCELLED", "by": "<운영자 2인>", "reason": "<사유>"}');
     UPDATE bounty_reward rw
        SET status = CASE WHEN p.open_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= LEAST(rw.amount, rw.deposited_amount))
                          THEN 'PAID' ELSE 'PARTIALLY_PAID' END
       FROM bounty b,
            (SELECT count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
                    count(*) FILTER (WHERE status NOT IN ('PAID', 'CANCELLED'))::int AS open_count,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid_amount
               FROM payout WHERE bounty_reward_id = (SELECT bounty_reward_id FROM payout WHERE id = '<payout id>')) p
      WHERE rw.id = (SELECT bounty_reward_id FROM payout WHERE id = '<payout id>') AND b.id = rw.bounty_id
        AND rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID') AND p.paid_count > 0;
     COMMIT;
     ```
     취소가 남기는 것 (규칙: `src/rewards/payout-status.ts` — 상태 목록을 바꾸면 위 SQL도 함께 고친다):
     - 그 payout의 금액은 배정에서 풀려 멀티시그에 남는다(취소만 배정을 풀고, `FAILED`는 계속 차지한다). 여유분 안에서 **다른** 승인 제출에는 다시 payout을 요청할 수 있다.
     - 그 수상자의 지급 상태(`/submissions/me` `payment_status`, 공개 프로필 `payoutStatus`)는 `NONE`이 된다 — "지급 대기"로 남지 않는다.
     - 바운티 COMPLETED·CANCELLED 전이를 막지 않는다. 두 전이의 `UNPAID_WINNERS`(같은 규칙 — docs/decisions.md 2026-10-25)는 진행 중 payout(`REQUESTED`/`AWAITING_MULTISIG_APPROVAL`/`APPROVED`/`BROADCASTING`)과, 아직 받을 몫이 남은 승인 제출(여유분이 남았는데 payout이 없거나, `FAILED` payout이 걸린 제출)만 센다. 다른 수상자가 풀을 다 가져간 승인 제출도 막지 않는다.
     - `FAILED` payout은 위 취소 SQL의 `WHERE status IN (...)`에 걸리지 않는다(UPDATE 0). `FAILED`는 받을 몫이 남은 것으로 보므로 COMPLETED와 CANCELLED(그래서 §7.7 환불도)를 계속 막는다 — 닫으려면 **온체인에서 송금되지 않았음을 먼저 확인**하고(멀티시그 tx 이력), 같은 트랜잭션을 `WHERE id = '<payout id>' AND status = 'FAILED'`로 바꿔 돌린다(감사 `before_data`는 `{"status": "FAILED"}`). 실제로 송금됐다면 취소하지 말고 tx 해시를 확인해 사후 기록으로 남긴다.
     - 승인됐지만 payout이 없던 수상자가 그 사이 탈퇴했다면, 취소로 생긴 여유분이 있어도 그 수상자는 받을 몫으로 세지 않는다(requestPayout이 404라 받을 수 없다).
     - 풀린 금액이 아무에게도 배정되지 않으면 바운티 삭제는 계속 409 `BOUNTY_HAS_OPEN_FUNDS`(남은 돈)다. COMPLETED 바운티의 잔액 환불 경로(§7.7 스크립트는 CANCELLED 바운티만 받는다)와 payout 취소 API는 아직 없다 — 제품 결정 대기.
   - **지급할 수 없는 수상**(승인됐지만 payout을 만들 수 없음 — 대표적으로 수상자가 지갑을 연결하지 않고 연락이 끊김) → `POST /admin/payouts`는 404 `APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND`인데, 지갑만 없는 수상자는 다시 연결할 수 있으므로 "받을 몫이 남은" 것으로 세져 COMPLETED와 CANCELLED가 **둘 다** 400 `UNPAID_WINNERS`로 막힌다. 먼저 연락·지갑 연결 안내를 하고(기한을 정해 기록), 그래도 안 되면 두 운영자 합의 후 수상을 몰수한다:
     ```bash
     railway run node scripts/forfeit-award.js <submission-id> --reason "<사유>" --admin <결정 운영자 user id> --dry-run
     railway run node scripts/forfeit-award.js <submission-id> --reason "<사유>" --admin <결정 운영자 user id>   # 확인 프롬프트에 yes
     ```
     한 트랜잭션(바운티 → 제출 잠금)에서 제출을 `APPROVED` → `REJECTED`로 바꾸고, `submission_review`(reviewer = `--admin`, decision `REJECT`, comment `forfeited: <사유>`)와 감사 `SUBMISSION_AWARD_FORFEITED`(actor = `--admin`, before/after + 사유)를 남긴다. 거부 조건(아무것도 쓰지 않고 exit 1): 바운티가 삭제됨 또는 `OPEN`/`SUBMISSION_CLOSED`/`IN_REVIEW`가 아님, 제출이 `APPROVED`가 아님, 그 제출의 payout 행이 **하나라도** 있음(상태 무관 — 위의 정정/취소로 다룬다), 완료 NFT 행이 있음, `--admin`이 활성 is_admin 유저가 아님. 이미 COMPLETED/CANCELLED로 닫힌 바운티의 수상은 이 스크립트 대상이 아니다.
     몰수가 남기는 것 — **사례별 운영자 결정**이다(되돌리는 스크립트는 없다. 되돌리려면 같은 형식의 SQL + 감사 행):
     - `max_winners` 자리가 하나 빈다 — 다른 제출을 승인할 수 있다.
     - 이 수상이 공개 프로필 `completedBounties`와 명예의전당 집계(둘 다 `APPROVED` 기준)에서 빠진다. 제출자의 `/submissions/me`에는 `REJECTED`, `payment_status` `NONE`(APPROVED가 아닌 행은 항상 `NONE` — 나중에 지갑을 연결해도 payout을 요청할 수 없다), `review_comment` `forfeited: <사유>`가 보인다 — 사유는 제출자가 읽는다고 보고 쓴다.
     - 받을 몫이 남은 수상자로 세지 않으므로 COMPLETED·CANCELLED 차단이 풀린다. 취소한다면 §7.7로 입금액 − `PAID` 전액을 환불·기록한 뒤 삭제할 수 있다.
   - 수령 지갑이 틀림 → SQL로 `recipient_wallet_id`를 바꾸지 않는다. 수령 지갑은 요청 시점의 대표 지갑이므로 먼저 3번으로 지갑 이력을 확인한다.
   - 잘못된 주소로 **실제 송금됨** → 온체인 회수는 불가. 수령자 연락/추가 지급 여부를 결정하고, 결정과 tx를 사후 기록에 남긴다.
3. 수령 지갑은 payout 요청 시점의 대표 지갑이다. 사용자가 지갑을 바꿨다고 주장하면 `wallet` 행의 `verified_at`과 비교한다(MVP는 지갑 교체 불허, decisions.md).

### 7.5 `JWT_SECRET` 유출
`JWT_SECRET`은 access 토큰·OAuth state 서명과 refresh 유예 사본 암호화(HKDF) 키다. 유출되면 누구나 임의 사용자 id로 access 토큰을 위조할 수 있다(어드민 라우트는 AdminGuard가 DB `is_admin`을 다시 보므로, 실제 어드민의 user id를 아는 경우에만 통과).

교체 절차 (즉시):
1. 새 값 생성: `openssl rand -base64 48`.
2. Railway Variables에서 `JWT_SECRET` 교체 → 재배포(교체 자체가 재배포를 일으킨다). 이전 값과 새 값을 동시에 받는 기능은 **없다** — 하드 컷이다.
3. 교체 직후 효과:
   - 기존 **access 토큰 전부 무효**(위조 토큰 포함) → FE가 401을 받고 refresh 쿠키로 조용히 재발급 → **대부분의 사용자는 로그인이 유지된다**(refresh 토큰은 무작위 값의 해시라 `JWT_SECRET`과 무관).
   - 교체 순간 진행 중이던 Google 로그인(state JWT)은 실패 → 다시 로그인.
   - 30초 유예 사본은 새 키로 복호화되지 않는다 → 교체 30초 안에 여러 탭이 동시에 refresh한 사용자는 401 + 세션 사슬 폐기로 재로그인.
   - 에이전트 API 키(해시 저장)는 영향 없음.
4. DB도 함께 유출됐거나 refresh 토큰 탈취가 의심되면 **전체 세션 폐기**(모든 사용자 재로그인):
   ```sql
   UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL WHERE revoked_at IS NULL;
   ```
5. 사후: 유출 기간의 `audit_log`(특히 어드민 액션)와 `auth_session` 생성 IP를 검토한다. 유출 경로(로그, 공유 화면, `.env` 커밋)를 막는다.

### 7.6 마스터 지갑 니모닉(`MASTER_WALLET_MNEMONIC`) 유출
마스터 지갑은 **NFT 민팅 전용**이다. 보상금은 멀티시그(§9)에 있으므로 이 지갑으로 움직일 수 없어야 한다 — 마스터 지갑 주소가 멀티시그 서명자가 아님을 §9 표로 확인한다.
1. **민팅 중지**: Railway에서 `MASTER_WALLET_MNEMONIC`을 비우고 재배포 → 워커가 잡을 실패시키지 않고 1시간씩 미룬다.
2. **자금 이동**: 유출된 주소의 남은 INJ(가스)를 새 지갑으로 옮긴다(공격자보다 먼저).
3. **새 지갑 생성**: 오프라인에서 새 니모닉 생성, 하드웨어/비밀 저장소에 보관(env는 Railway에만). 새 주소에 가스 INJ 충전.
4. **컨트랙트 권한 이전**: CW-721 컨트랙트의 minter(소유권)를 새 주소로 넘긴다 — cw721-base 계열은 `update_ownership { transfer_ownership: { new_owner } }` 실행 후 새 지갑으로 `accept_ownership`(컨트랙트 버전에 맞는 메시지를 확인). 유출된 키로 먼저 실행해야 하므로 2번과 같이 서두른다. 권한을 이미 빼앗겼으면 새 컨트랙트 배포 + `NFT_CONTRACT_ADDRESS` 교체(§8의 NFT 항목과 같은 결정이 필요).
5. **무단 민팅 확인**: 유출 시점 이후 마스터 주소의 tx를 익스플로러에서 보고, 컨트랙트의 토큰 중 `nft.id`(token_id = nft UUID)와 맞지 않는 것을 목록화한다.
6. 새 니모닉을 `MASTER_WALLET_MNEMONIC`에 넣고 재배포 → 미뤄진 잡이 돈다. FAILED가 있으면 §7.3의 재시도.
7. 운영 전 과제: 니모닉을 env 대신 KMS/Vault로(security.md "운영 전").

### 7.7 환불 기록 — 취소된 바운티의 입금을 스폰서에게 돌려준 뒤
`CANCELLED` 바운티의 보상에 돈이 남아 있으면(입금액 − `PAID` payout 합계 > 0 — 보상 상태가 `FUNDED`/`PARTIALLY_PAID`/`PAID`/`REFUND_PENDING` 어느 것이든) 바운티 삭제가 409 `BOUNTY_HAS_OPEN_FUNDS`로 막힌다. 삭제 가드는 배정 상한이 아니라 **입금액 전체**와 비교하므로(2026-10-25), 초과 입금분(입금 150 / 게시 100이면 50)과 max_winners를 채워 보상이 `PAID`로 닫혔지만 상한보다 적게 지급된 잔액도 여기서 환불·기록해야 삭제할 수 있다. API에는 환불 기록 엔드포인트가 없으므로 이 스크립트가 유일한 경로다 — 손으로 쓴 SQL을 운영 DB에 직접 실행하지 않는다 (감사 행이 남지 않는다).
1. 열린 payout을 정리한다 (`GET /admin/bounties/:id/operations`). `PAID`/`CANCELLED`/`FAILED` 밖의 payout이 있으면 스크립트가 거부한다 — 취소하거나 §7.4로 마무리한다. 받을 몫이 남은 수상자(진행 중·`FAILED` payout, 또는 여유분이 남았는데 payout이 없는 승인 제출)가 있으면 바운티 취소 자체가 400 `UNPAID_WINNERS`다(2026-10-25 결정) — 모두 지급하거나 §7.4대로 수상을 취소한 뒤 취소한다. 그 전에 이미 취소된 바운티는 스크립트가 이 검사를 하지 않으므로, 실행 전에 승인 제출마다 `PAID` 또는 `CANCELLED` payout이 있는지 직접 확인한다.
2. 멀티시그에서 스폰서 주소로 **환불 송금**을 서명·전송한다. 금액 = 입금액 − `PAID` payout 합계 (스크립트가 `--dry-run`에서 `refundedAmount`로 보여 준다). 송금 tx 해시를 받아 둔다.
3. 점검 후 기록:
   ```bash
   railway run node scripts/record-refund.js <reward-id> --tx <hash> --dry-run
   railway run node scripts/record-refund.js <reward-id> --tx <hash>          # 확인 프롬프트에 yes
   ```
   거부 조건(아무것도 쓰지 않고 exit 1): 바운티가 `CANCELLED`가 아님, 보상이 위 네 상태가 아님(`DEPOSIT_PENDING`/`REFUNDED`/`CANCELLED`), 열린 payout 있음, 환불할 금액이 0 이하, 해시가 이미 입금/지급/환불 증빙으로 기록됨. 보상이 여러 개면 보상마다 한 번씩 실행한다.
4. 확인: `GET /admin/audit-logs?entityType=bounty_reward&entityId=<reward-id>`에 `REWARD_REFUNDED`. 모든 보상이 `REFUNDED`(또는 입금액 전액 지급된 `PAID`)가 되면 바운티를 삭제할 수 있다.

**COMPLETED 바운티의 잔액은 이 경로가 없다**: 전액 지급됐지만 초과 입금분이 남은(또는 상한보다 적게 지급된) `COMPLETED` 바운티는 스크립트가 `not CANCELLED`로 거부하고 삭제는 409로 남는다(COMPLETED는 다른 상태로 갈 수 없다). COMPLETED 잔액 환불은 제품 결정 대기(§7.4 "풀린 금액") — 그때까지는 의도된 동작이다. 초과 입금이 보이면 COMPLETED로 닫기 **전에** 취소·환불 여부를 정한다.

## 8. testnet → mainnet 전환

전환은 **한 번의 점검 창**에서 BE·FE를 같이 바꾼다. 테스트넷 데이터는 그대로 남으므로(돈·NFT가 테스트넷 것) 먼저 정리한다.

### 8.1 사전 점검 (읽기 전용)
```bash
railway run sh -c 'psql "$DATABASE_URL" -X -f scripts/mainnet-preflight.sql \
  -v expected_custody=<mainnet 멀티시그 inj1…> \
  -v expected_usdc=<mainnet USDC ERC-20 0x…> \
  -v expected_nft_contract=<mainnet CW-721 inj1…>'
```
- **blocker**(0행이어야 진행): `custody_placeholder`(열린 보상의 custody가 `PENDING_MULTISIG_SETUP`/잘못된 모양/새 멀티시그와 다름), `erc20_testnet_chain`(열린 ERC-20 보상이 1439 또는 다른 USDC), `payout_open`(끝나지 않은 payout), `nft_job_unfinished`(대기·진행·실패 잡 — 전환 후 메인넷에 민팅된다).
- **review**: `reward_funded_on_testnet`(테스트넷 입금 — 메인넷 재입금 또는 환불/취소 결정), `nft_contracts`(테스트넷 컨트랙트의 NFT — 재민팅 여부), `active_admins`, `platform_settings`, `last_migration`.
- blocker 정리는 운영자 화면(바운티 취소, payout 완료 기록)으로 하고, 화면이 없는 것(잡 취소, 테스트 보상 정리)은 두 운영자 합의 하에 SQL + 감사 행으로 한다(§7.4의 형식).

### 8.2 env 변경

| 위치 | 키 | testnet (현재) | mainnet |
|---|---|---|---|
| BE `.railway/railway.ts` | `INJECTIVE_NETWORK` | `testnet` | `mainnet` (→ `@injectivelabs/networks` Mainnet 프리셋, `injective-nft.client.ts`) |
| BE `.railway/railway.ts` | `INJECTIVE_EVM_CHAIN_ID` | `1439` | `1776` |
| BE `.railway/railway.ts` | `USDC_EVM_CONTRACT_ADDRESS` | `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d` | 메인넷 USDC ERC-20 주소 (Injective 공식 문서에서 확인 — 추측 금지) |
| BE `.railway/railway.ts` | `NFT_CONTRACT_ADDRESS` | `inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w` | 메인넷에 배포한 CW-721 주소 |
| BE Railway 변수 | `REWARD_MULTISIG_ADDRESS` | (테스트넷 멀티시그 또는 비어 있음) | 메인넷 멀티시그 주소 (§9) |
| BE Railway 변수 | `MASTER_WALLET_MNEMONIC` | 테스트넷 키 | **새** 메인넷 전용 키 (재사용 금지), 가스 INJ 충전, 컨트랙트 minter |
| BE Railway 변수 | `INJECTIVE_GRPC_ENDPOINT` | 비어 있음(프리셋) | 선택 — 전용 메인넷 노드 |
| FE `.env.production` | `NEXT_PUBLIC_INJECTIVE_EVM_CHAIN_ID` | `1439` | `1776` |
| FE `.env.production` | `NEXT_PUBLIC_INJECTIVE_EVM_RPC_URL` | `https://k8s.testnet.json-rpc.injective.network/` | 메인넷 JSON-RPC (예: `https://sentry.evm-rpc.injective.network/`) — chain과 **같이** 바꿔야 FE 빌드가 통과한다(`src/lib/runtime/config.ts` 짝 가드) |

### 8.3 순서
1. 점검 창 공지 → 8.1 blocker 0행 확인 → 백업(§5 덤프 1회).
2. BE: `railway.ts` 변경 PR 머지 + Railway 변수 교체 → 배포. 로그에서 네트워크/컨트랙트 확인.
3. FE: `.env.production` 변경 PR → `develop` → `main`.
4. 확인: 테스트 바운티에 보상 등록 → `custody_address`가 메인넷 멀티시그, ERC-20이면 `evm_chain_id = 1776`. 새 지갑 연결 사용자 1명의 부모 NFT가 메인넷 컨트랙트에 민팅되는지(`nft_job` SUCCEEDED, 익스플로러).
5. 8.1을 다시 돌려 blocker가 0행인지 확인하고 결과를 사후 기록에 붙인다.

## 9. 멀티시그 서명자 문서 템플릿

보상금 보관 멀티시그의 오프체인 정책. 결정 기본값은 **2-of-3** (decisions.md "멀티시그 서명 인원/기준"). 이 표는 레포가 아니라 운영자만 접근 가능한 문서에 복사해 채운다(개인 연락처 포함).

```markdown
# NinjaLabs 보상 멀티시그 — 서명자 정책

- 네트워크: Injective mainnet / testnet
- 멀티시그 주소 (= REWARD_MULTISIG_ADDRESS):
- 종류: cw3-fixed-multisig / Safe(EVM) / 기타:
- 임계값: 2-of-3
- 생성 tx / 생성일:
- 마지막 검토일:

## 서명자
| # | 이름 / 역할 | 서명 주소 | 키 보관 방식 (하드웨어 지갑 모델 등) | 연락 수단 (비상) | 추가일 |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

규칙
- 서명자는 마스터 민팅 지갑(MASTER_WALLET_MNEMONIC)과 다른 키를 쓴다. 한 사람이 두 서명 키를 갖지 않는다.
- 지급(payout) 승인: BE의 payout 2인 규칙(요청자 ≠ 승인자)과 별개로, 온체인 서명도 임계값만큼 모은다.
- 송금 직후 BE에 `POST /admin/payouts/:id/paid {txHash}`로 기록한다 (기록 누락 = 이중 지급 위험).
- 환불: 바운티 취소 시 스폰서 주소로 송금 후 보상 상태를 REFUNDED로 기록한다 (decisions.md).

## 서명자 교체
1. 사유 / 대상 / 새 서명자 합의 (기존 서명자 임계값 이상 동의)
2. 멀티시그의 멤버 변경 tx (또는 새 멀티시그 생성 + 잔액 이동 + REWARD_MULTISIG_ADDRESS 교체 — 새 주소면 열린 보상의 custody_address도 확인: scripts/mainnet-preflight.sql `-v expected_custody=`)
3. 이 표 갱신, 변경 tx 링크 기록

## 키 분실 / 유출
- 서명자 1명 키 분실·유출: 임계값(2) 미만이므로 즉시 위험은 없다. 남은 서명자로 멤버 교체를 최우선 처리.
- 2명 이상: 남은 잔액을 즉시 새 멀티시그로 이동할 수 있는지 확인하고, 불가하면 사고로 공지.

## 변경 이력
| 날짜 | 변경 | 승인자 | tx |
|---|---|---|---|
```
