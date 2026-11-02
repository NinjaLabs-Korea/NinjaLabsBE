# 배포와 환경 변수

> 마이그레이션과 코드를 어떤 순서로 내보내는지, production에 어떤 env가 있어야 하는지, 로컬에서 FE와 어떻게 붙이는지.
> 첫 배포 전체 순서와 장애 대응은 [runbook.md](runbook.md)에 있다.

## 배포 순서 (Railway): 마이그레이션이 먼저, 코드가 나중

`main`에 머지하면 Railway가 바로 운영에 배포한다.

새 BE 코드는 새 스키마를 전제로 한다 (예: 0014의 `auth_session` 컬럼이 없으면 `/auth/exchange`·`/auth/refresh`가 500). 그래서 두 겹으로 막는다.

1. **`.railway/railway.ts`의 `preDeploy: "npm run migrate"`** - Railway가 새 컨테이너를 띄우기 전에 `supabase/migrations`를 적용한다
   (`railway` 패키지 `IntentServiceConfig.preDeploy`). 실패하면 배포가 중단되고 구 버전이 계속 서비스된다.
2. **`SchemaGuard`** (`common/database/schema-guard.ts`, `DatabaseModule`의 `onModuleInit`) - 기동 시 `supabase/migrations/*.sql` 전부가
   `_migrations`에 있는지 확인하고, 빠진 게 있으면 listen 전에 `FATAL: MIGRATIONS_PENDING: run npm run migrate (missing: 0014_…)`를 찍고 exit 1.
   preDeploy를 우회해 배포했거나(수동 `railway up`, 다른 호스팅) `npm run migrate`가 실패한 채 컨테이너만 올라오는 상황을 잡는다.

따라서 수동 배포라면 **`npm run migrate` → 새 코드 기동** 순서를 지킨다. `scripts/migrate.js`는 실행 전체를 `pg_advisory_lock`(고정 키 `MIGRATION_LOCK_KEY`)으로 직렬화한다 - 두 배포의 preDeploy가 겹치면 뒤의 것은 `wait  another migration run holds the lock`을 찍고 기다렸다가 이미 적용된 파일을 skip한다 (`src/test-db/migrate-lock.db-spec.ts`). 파일 하나를 트랜잭션 하나로 적용하므로 파일 안의 최상위 `BEGIN`/`START TRANSACTION`/`COMMIT`/`END`/`ROLLBACK`/`ABORT`/`PREPARE TRANSACTION`은 **실행 전에 거부**한다 (주석·문자열·`$$` 본문은 제외, 모든 파일을 먼저 검사해 하나라도 걸리면 아무것도 실행/기록하지 않고 `FAIL  <file>:<line>`으로 exit 1 - `docs/runbook.md` §2). 적용 중에는
`RAISE NOTICE`/실패 시 `HINT`를 그대로 출력한다. `0014`는 `deposit_tx_hash` 중복이 남아 있으면 **에러로 멈춘다**(중복 값·건수·조사 SQL 포함) -
운영자가 정리한 뒤 다시 `npm run migrate`하면 이어서 적용된다 (`src/test-db/migrations.db-spec.ts`). `payout_tx_hash`는 정규화만 한다 (한 멀티시그 tx가 여러 수상자에게 보낼 수 있어 중복이 정당하다).

첫 배포 전체 순서(Railway 설정 반영 → env → BE → OAuth → FE → 어드민 부트스트랩 → 모니터)와 운영 절차는 **[runbook.md](runbook.md)**.

## production에 있어야 하는 env (`NODE_ENV=production`)

기동 검사는 `common/bootstrap-checks.ts`·`auth.service.ts`·`database.service.ts`에 있다. 한 번 올라간 뒤가 아니라 **첫 컨테이너가 뜨기 전에** Railway 변수에 넣어 둔다
(`.railway/railway.ts`의 `preserve()` 자리). 빠지면 아래 "결과" 열대로 동작한다 - 거부되는 것만 크래시 루프가 된다.

| env | 결과 |
|---|---|
| `DATABASE_URL` | 없으면 `preDeploy`의 `npm run migrate`가 실패해 배포 중단 (구 버전 유지) |
| `JWT_SECRET` | 미설정 또는 `.env.example` 자리표시값이면 **기동 거부**. 32바이트 미만이어도 **기동 거부**(`openssl rand -base64 48`). 서명/검증 알고리즘은 HS256으로 고정(`auth/jwt-algorithm.ts`) |
| `GOOGLE_CLIENT_SECRET` | 없으면 **기동 거부** (로그인이 어차피 전부 실패) |
| `TRUST_PROXY` | 미설정/빈 값이면 **1로 보고 `warn`** (Railway는 항상 프록시 1홉 뒤). 명시적 `0`/비정수는 **기동 거부** - railway.ts가 `1`을 넣는다 |
| `JWT_REFRESH_TTL` | 미설정이면 `14d`. 형식/범위(60초~90일)가 틀리면 기동 거부 |
| `JWT_ACCESS_TTL` | 미설정이면 `15m`. `JWT_REFRESH_TTL`과 같은 문법(`<정수><단위>` - 단위 없는 `900`은 jsonwebtoken이 밀리초로 읽어 발급 즉시 만료되므로 거부), 범위 60초~60분. 틀리면 환경과 무관하게 **기동 거부** - railway.ts가 `15m`을 넣는다 |
| `LEGACY_ACCESS_TOKEN_CUTOFF` | 선택. 미설정이면 프로세스 시작 시각 - 그 전에 발급된 `typ` 없는 구 access 토큰만 받는다(15분 뒤 자연 소멸). ISO 8601이 아니면 기동 거부. 2026-11-30 이후 코드와 함께 제거 |
| `DATABASE_CA_CERT` | production에서 비어 있으면(`PGSSLMODE=disable` 제외) **기동 거부**, `npm run migrate`(preDeploy)도 실패해 배포가 멈춘다 (TLS 서버 인증서를 검증하지 않게 되므로) |
| `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` | 선택, 기본 `5000`/`15000` ms (잘못된 값은 기본값). 연결 수립·풀 대기 초과 → 그 요청 `503 DATABASE_UNAVAILABLE`, 문장 초과 → Postgres 취소(500). migrate/운영 스크립트는 연결 타임아웃만 쓰고 문장 타임아웃은 걸지 않는다 (`common/database/pool-timeouts.ts`) |
| `THROTTLER_STORAGE` | 선택. 미설정이면 production은 `postgres`(레플리카 간 공유 rate limit 카운터, `throttler_storage` - 0016), 그 외는 `memory`(인스턴스별). `postgres`/`memory` 외의 값은 **기동 거부**. railway.ts가 `postgres`를 명시한다 - `memory`로 바꾸면 레플리카 N대에서 한도가 N배 (`docs/security.md`) |
| `TURNSTILE_SECRET_KEY` | 선택. 설정하면 `GET /auth/google`이 Cloudflare Turnstile 토큰(`turnstileToken`)을 요구한다 (실패는 FE 콜백 `#error=TURNSTILE_FAILED` / `#error=TURNSTILE_UNAVAILABLE`로 302). 미설정이면 검사 생략 + production 기동 시 `warn`. **FE(`NEXT_PUBLIC_TURNSTILE_SITE_KEY`)를 먼저 배포**한 뒤 넣는다 - 순서가 바뀌면 모든 로그인이 400 |
| `REWARD_MULTISIG_ADDRESS` | 기동은 하지만(거부하지 않음) 미설정/빈 값이면 새 보상의 `custody_address`가 자리표시값 `PENDING_MULTISIG_SETUP` - 스폰서가 입금할 주소가 없다. production 기동 시 미설정·빈 값·모양 불일치(`inj1`+38/58자 bech32 체크섬, 또는 EVM `0x`+40 hex - `mainnet-preflight.sql`과 같은 집합)면 **`error` 로그** (값은 그대로 쓴다). `railway.ts`의 `preserve()` 자리 - 값은 대시보드/CLI로 넣는다 (`docs/runbook.md` §1, §8) |
| `PAYOUT_ALLOW_SELF_APPROVAL` | 선택, 기본 `false` - payout 승인 2인 규칙(요청자 ≠ 승인자, 403 `PAYOUT_SELF_APPROVAL`). 운영자 1인일 때만 `true` → 자기 승인 허용 + 기동/승인 시 `warn` + 감사 `PAYOUT_SELF_APPROVED`. railway.ts에는 값 없이 `preserve()` 자리만 있다(기본값 유지 - 대시보드에서 켠 값이 apply로 지워지지 않게) |
| `WALLET_REPLACEMENT_ENABLED` | 기본 OFF, 정확한 `true`만 활성화. 0024–0028 호환 배포와 모든 구버전 writer 드레인 뒤 켠다. OFF면 challenge/verify 모두 503 `WALLET_CHANGE_DISABLED`. IaC는 `preserve()`로 운영자 선택을 보존한다 |
| `NFT_MINTING_ENABLED` | 미설정/빈 값/`true`이면 **기존 NFT 자동 발급 유지**(체인 설정/자격 증명 필요). `false` 및 그 밖의 비어 있지 않은 값은 워커 중지. 중지 중에도 API 잡 등록은 계속된다. 복원 전 반드시 `false`를 명시하고 모든 old/new 워커를 중지·드레인한 후 체인 대조한다. 이미 전송한 tx 취소/복원 자동 감지는 아니다. [반영 체크리스트](wallet-replacement-release.md) 참고 |
| `OPS_ALERT_WEBHOOK_URL` | 선택 (railway.ts `preserve()`). Discord/Slack incoming webhook(https). 없으면 알림은 `OpsAlert` warn 로그로만, https가 아니면 기동 시 `error` 로그 후 무시 (기동은 함). 대상·규칙은 `docs/security.md` "운영 알림" |
| `CORS_ORIGINS` | 미설정/빈 값이면 **기동 거부** (production에는 localhost 폴백이 없다). `localhost`/`127.x`/`::1` 항목은 **빼고 `error` 로그**(기동은 함 - 옛 main의 railway.ts가 `http://localhost:3000`을 넣었기 때문), 그것만 있으면 기동 거부. 쓸 수 있는 오리진이 하나도 안 남아도(스킴 없는 `ninjalabsfe.vercel.app`, 오타, 공용 호스팅 와일드카드뿐) **기동 거부** - 항목은 `https://host[:port]` 모양이어야 한다. railway.ts에 공개값으로 고정 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CALLBACK_URL`, `AUTH_SUCCESS_REDIRECT` | 미설정/빈 값이면 **기동 거부**. 두 URL은 http(s) URL이 아니거나 localhost/`127.x`이면 **기동 거부** (예전엔 `AUTH_SUCCESS_REDIRECT`가 `http://localhost:3000/`으로 폴백). railway.ts에 공개값으로 고정 |
| `AUTH_ALLOWED_REDIRECT_ORIGINS` | 선택. 값이 틀리면 그 오리진으로의 `returnTo`가 무시될 뿐 |

## 로컬 오리진 (CORS, 로그인 returnTo)

production(`.railway/railway.ts`)의 `CORS_ORIGINS`에는 `http://localhost:3000`이 **없다** - 아무 브라우저 탭의 localhost 페이지가 운영 API를 자격 증명과 함께 부를 수 없게.
로컬 FE는 로컬 BE에 붙인다: `.env`(`.env.example` 복사)의 `CORS_ORIGINS=http://localhost:3000`, `AUTH_SUCCESS_REDIRECT=http://localhost:3000/`가 기본값이고,
다른 포트/호스트로 FE를 띄우면 `CORS_ORIGINS`와 `AUTH_ALLOWED_REDIRECT_ORIGINS`에 그 오리진을 콤마로 덧붙인다 (예: `CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3001`).
로컬 FE로 운영 BE를 꼭 써야 한다면 운영 변수를 바꾸지 말고 FE의 mock 모드나 Vercel preview(정확한 별칭 항목)를 쓴다.

## DB 접속 (Supabase)

Supabase 프로젝트 생성 후 `Project Settings → Database → Connection string`을 `DATABASE_URL`에 넣으면 된다. Supabase CLI를 쓰는 팀이면 `npm run migrate` 대신 `supabase db push`도 가능 (마이그레이션 디렉터리 규칙 호환).
