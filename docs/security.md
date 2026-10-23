# 보안 체크리스트

> 스캐폴드에 반영된 것 / 구현 단계(Phase 1~3)에서 반드시 챙길 것을 구분해 관리한다.
> PR 리뷰 시 이 문서를 기준으로 확인.

## ✅ 스캐폴드에 반영됨

| 항목 | 위치 |
|---|---|
| SQL 인젝션 차단 — 전 쿼리 파라미터 바인딩, 문자열 조립 없음 | 전체 서비스 |
| refresh token / agent API key **해시만 저장** (sha256), 원문 DB 저장 금지 | `auth.service.ts`, `agents.service.ts` |
| 에이전트 API key 인증 — prefix 후보 조회 + timing-safe 해시 비교 + 만료/폐기/에이전트 상태 검증 | `agent-api-key.service.ts`, `agent-api.guard.ts` |
| refresh token **회전** — 재발급 시 구 토큰 즉시 폐기, 폐기 토큰 재사용 거부 | `auth.service.ts` refresh() |
| production 기동 조건 — **거부(fail-fast)**: `JWT_SECRET` 미설정/기본값, `GOOGLE_CLIENT_SECRET` 미설정, `TRUST_PROXY`가 명시적 `0`/비정수. **기동하되 로그**: `TRUST_PROXY` 미설정 → 1홉으로 보고 `warn`(Railway는 항상 프록시 1홉 뒤 — env 하나 빠졌다고 크래시 루프가 되지 않게), `JWT_SECRET` 32바이트 미만 → `error`(즉시 교체), `DATABASE_CA_CERT` 비면 `warn` 1회 (인증서 미발급 허용). 첫 배포 전 env 목록은 README "이 브랜치 첫 배포 전에 있어야 하는 env" | `common/bootstrap-checks.ts`, `main.ts`, `auth.module.ts`, `database.service.ts`, `.railway/railway.ts` |
| **스키마 선행 검사** — 모든 환경에서 기동 시 `supabase/migrations/*.sql` 전부가 `_migrations`에 있어야 한다. 빠지면 listen 전에 `FATAL: MIGRATIONS_PENDING: run npm run migrate (missing: …)` 후 exit 1 — 새 코드가 옛 스키마 위에서 떠 `/auth/exchange`·`/auth/refresh`가 요청마다 500 나는 배포 사고 방지. Railway는 `preDeploy: "npm run migrate"`가 먼저 돈다 (README "배포 순서") | `common/database/schema-guard.ts`, `database.module.ts`, `main.ts`, `.railway/railway.ts`, test-db `migrations.db-spec` |
| access JWT 용도 바인딩 — 발급 시 `typ: 'access'`, 검증 시 `typ === 'access'` + 문자열 `sub` 요구. 같은 시크릿으로 서명되는 OAuth state(`p: 'gstate'`)를 Bearer로 내면 401 | `auth.service.ts` verifyAccessToken, `auth.guard.spec.ts` |
| refresh 회전은 소유 유저가 `status='ACTIVE' AND deleted_at IS NULL`일 때만 — 정지/삭제 유저는 401이며 구 토큰은 소비된다 | `auth.service.ts` refresh() |
| refresh **재사용 감지 + 30초 유예** — 회전된 토큰이 30초 안에 다시 오면(멀티탭 레이스) 후속 쌍을 그대로 돌려주고(재회전 없음), 창 밖이거나 후속이 이미 회전/폐기됐으면 401 + 그 토큰에서 파생된 세션 사슬 전체 폐기(한 홉씩 `FOR UPDATE`로 잠그며 따라감 — 재귀 CTE 한 문장은 동시 진행 중인 정당한 회전이 만든 후속 행을 스냅샷 밖이라 놓친다, test-db `auth.db-spec`). 유예용 후속 토큰 사본은 AES-256-GCM(JWT_SECRET 파생 키)으로 `auth_session.grace_refresh_token`에 30초만 둔다 — 해시만 저장 원칙의 유일하고 한시적인 예외 | `auth.service.ts` refresh(), `auth/refresh-grace.ts`, `0014` |
| 탈퇴(soft delete) 유저 재로그인 — `uq_user_email`/`uq_user_google_id`를 `deleted_at IS NULL` 부분 인덱스로; 그래도 충돌하면 409 `ACCOUNT_CONFLICT` → 콜백은 `#error=AUTH_FAILED` (500 없음) | `0014`, `auth.service.ts` upsertGoogleUser |
| 어드민 API 서버측 가드 — JWT `is_admin` 클레임 + 요청마다 `"user"` 행(`is_admin`, `status='ACTIVE'`, 미삭제) 재확인 → 어드민 해제/정지 즉시 반영 | `admin.guard.ts` |
| 전역 rate limit (IP당 120/min) + 민감 엔드포인트 강화 (refresh 10/min, 닉네임 검사 30/min) | `app.module.ts`, 각 컨트롤러 |
| ⚠️ 두 throttler(전역 IP 120/min, Agent API 키별 60/min)의 카운터는 **인스턴스별 in-memory**(`@nestjs/throttler` 기본 저장소) — 레플리카 N대면 실효 한도가 N배가 된다. 1대를 넘기기 전에 공유 저장소(`@nestjs/throttler-storage-redis` 또는 pg 테이블)로 옮길 것 (`TODO(scale)`, `app.module.ts` / `agents.module.ts`) | `app.module.ts`, `agents/agents.module.ts` |
| 보안 헤더 (helmet) | `main.ts` |
| CORS / `returnTo` 오리진 허용 목록 — 정확한 오리진 또는 (팀 소유 도메인에서만) 호스트 레이블 1개의 `*` 와일드카드, 스킴·포트 일치, 호스트 전체 앵커 (`evil.com/?x=…` 불가). 공용 호스팅 접미사 위의 와일드카드는 위치와 무관하게 거부 | `common/origin-allowlist.ts`, `main.ts`, `auth.controller.ts` |
| DTO whitelist + `forbidNonWhitelisted` — 정의 안 된 본문/쿼리 필드는 400 (mass assignment 방지) | `main.ts` ValidationPipe |
| 공개 목록 페이지네이션 입력 검증 (`page`≥1, `pageSize` 1~50 정수) — 잘못된 값은 500이 아니라 400 | `common/pagination.dto.ts` |
| 어드민 유저 검색 ILIKE 메타문자(`%`, `_`, `\`) 이스케이프 | `members/member-admin.service.ts` |
| 입력 상한 — 닉네임 2~50 `^[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]$`(문자/숫자로 시작·끝, 공백 불가, trim, 라우트 예약어 `me`/`check-nickname`/`admin`/`new`/`edit` 거부 — `users/nickname.ts`), bio 1000, 지원 message 4000, 제출 description 8000, 심사 comment/note 2000, 공지 title 200/summary 500/body 50000, 하이라이트 title 200/description 2000, 바운티 title 200/summary 500/description 50000/requirements·evaluationCriteria 20000/sponsorName 100, 에이전트 name 100(FE 입력 maxLength와 동일)/description 1000, Agent API 지원 message 4000/제출 description 8000/commitSha 64. 보상은 중첩 DTO(`RewardDto`: tokenType IN, amount 정수 문자열, displaySymbol `^[A-Za-z0-9]{1,12}$`) | 각 컨트롤러 DTO, `bounties/admin/bounty-admin.dto.ts`, `*.dto.spec.ts` |
| URL 필드는 http(s)만 — `externalUrl`/`portfolioUrl`/`submissionUrl`/`repositoryUrl`는 `IsHttpUrl`, 이미지(`thumbnailUrl`/`imageUrl`/`coverImageUrl`)는 `POST /admin/media`의 `/media/<uuid>` 상대 경로도 허용, 하이라이트 `linkUrl`은 사이트 내부 경로 허용(`//host` 불가). `javascript:`/`data:` 차단 | `common/validation/url.ts` |
| `GET /admin/audit-logs` 쿼리 검증(`page`≥1 정수, `entityType`≤64, `entityId` UUID) + `{ items, page, pageSize, total }` 봉투 | `audit/audit.controller.ts`, `audit.service.ts` |
| tx 해시 — `^(0x)?[0-9a-fA-F]{64}$`만 받아 `0x`+소문자로 정규화(400 `INVALID_TX_HASH`). 입금: `uq_bounty_reward_deposit_tx` 부분 유니크로 한 해시를 두 보상에 쓰면 409 `TX_HASH_ALREADY_USED`. 송금: payout 해시에는 유니크 인덱스가 **없다** — 멀티시그 tx 하나가 여러 수상자에게 보내므로 같은 바운티 안의 재사용은 허용(info 로그)하고, **다른 바운티**의 PAID payout에 이미 쓰인 해시만 `markPaid`가 UPDATE 전 조회(해시별 advisory lock으로 직렬화)로 409. payout 승인도 감사 로그와 같은 트랜잭션. `0014`는 기존 행을 같은 규칙으로 정규화한 뒤 **입금 해시** 중복이 남아 있으면 **마이그레이션을 실패시킨다**(`RAISE EXCEPTION` — 중복 값 최대 10개·건수·조사 SQL 포함, 전체 롤백·`_migrations` 미기록·앱은 `MIGRATIONS_PENDING`으로 기동 거부). 운영자가 정리 후 `npm run migrate` 재실행하면 적용 | `common/validation/tx-hash.ts`, `rewards.service.ts`, `0014`, `scripts/migrate.js`, test-db `migrations.db-spec` |
| Agent API **키별 rate limit 60/min** (전역 IP 120/min과 별도) — tracker는 `AgentApiGuard`가 채운 agentId, 가드 순서 `[AgentApiGuard, AgentApiThrottlerGuard]`를 스펙으로 고정. 인증 조회는 잠금/트랜잭션 없이 조건부 `last_used_at` UPDATE만 | `agents/agent-api-throttler.guard.ts`, `agent-api-key.service.ts` |
| 에이전트 지갑 선점(squatting) 방지 — 남의 `PENDING_VERIFICATION` 행은 소유 증명이 아니므로 24시간이 지나면 버려진 것으로 보고 soft delete 후 등록 진행(행 잠금), 24시간 이내면 409. 내 `REVOKED` 에이전트는 지우지 않는다 — `uq_agent_wallet`/`uq_agent_public_key`가 REVOKED 행을 무시하므로(0014) 같은 지갑으로 재등록해도 이력이 남는다 | `agents.service.ts` register(), `0014` |
| 지갑 challenge는 (user, wallet)당 열린 것 1개 — 발급 시 미사용 행 삭제. 매시 크론: 만료+1일 지난 challenge, 폐기/만료 30일 지난 `auth_session`, 만료 `oauth_login_code` 삭제, 30초 지난 grace 사본 비움 | `wallets.service.ts`, `common/maintenance/maintenance.service.ts` |
| `nft_job.last_error` — 500자 절단 + `MASTER_WALLET_MNEMONIC` 출현 시 `[redacted]` | `nfts/nft-job.worker.ts` |
| 업로드 multipart 한도 — 파일 1개·5 MiB·fields 5·parts 10·fieldNameSize 100 | `media/media.controller.ts` |
| Google `id_token` **서명 검증** (Google JWKS, `google-auth-library` `verifyIdToken` + iss/aud/sub/email_verified 클레임 재확인) | `auth/google-id-token.verifier.ts`, `auth.service.ts` |
| 감사 로그는 변경과 **같은 트랜잭션**에 기록 (공지·하이라이트·멤버 지정·입금 확인·바운티 수정·에이전트 키 회전/폐기) | 각 `*-admin.service.ts`, `rewards.service.ts`, `agents.service.ts` |
| Agent API key 회전/에이전트 폐기 — 행 잠금 tx, 기존 ACTIVE 키 전부 폐기, 폐기된 키·에이전트는 즉시 401 | `agents.service.ts`, `agent-api-key.service.ts` |
| 어드민 바운티 수정 가드 — 접수 중(DRAFT/FUNDING_PENDING/OPEN)인 바운티의 마감을 과거로 **옮기는** 것 거부(저장값과 1분 미만 차이는 FE datetime-local 반올림으로 보고 "변경 없음" 처리, 접수가 끝난 상태에서는 제목/설명 수정이 지난 마감에 막히지 않도록 검사 생략), `maxWinners` < 승인 수 거부 (바운티 행 잠금) | `bounties/admin/bounty-admin.service.ts`, `bounties/bounty-status.ts` |
| nft_job 고아 정리 — 15분 넘게 PROCESSING인 잡을 PENDING으로 재큐잉, MINTING nft 복구 (워커 크래시 내성) | `nfts/nft-job.worker.ts` |
| 지갑 verify와 부모 NFT 민팅 잡 등록을 **같은 트랜잭션**에서 처리 — challenge 행을 `FOR UPDATE`로 읽고 조건부 `UPDATE … used_at = now() … RETURNING`으로 소비(0행이면 400 `CHALLENGE_EXPIRED`), 발급은 (user, wallet)별 advisory lock으로 직렬화해 열린 challenge는 항상 1개 | `wallets.service.ts`, `nfts.service.ts` |
| DB TLS — `DATABASE_CA_CERT`(PEM) 설정 시 `ssl.ca` + `rejectUnauthorized: true`로 서버 인증서 검증 | `common/database/database-ssl.ts`, `scripts/migrate.js` |
| 전역 예외 필터(5xx만 method/path/status/에러명 기록, 본문·헤더·토큰 미기록) + 요청 로그(method/path/status/ms, `/health` 제외) — 응답 포맷은 Nest 기본 유지 | `common/http/*` |
| payout / nft_job **멱등키** — 중복 지급·중복 민팅 DB 레벨 차단 | `0006`, `0007` 마이그레이션 |
| 세션/에이전트/지갑/바운티 흐름을 **실 Postgres**로 검증하는 통합 테스트 (`npm run test:db`, CI `db-tests` 잡) — mock DB로는 통과하는 파라미터 타입 충돌(42P08)·부분 유니크 인덱스·행 잠금 회귀를 막는다 | `src/test-db/*`, `jest.db.config.js` |
| 지갑 nonce 1회용 + 5분 만료 | `wallets.service.ts`, `0002` |
| 상태 전이 서버측 검증 (마감 후 제출, 승인 전 제출, 확정 후 수정 차단) | `submissions.service.ts`, `bounties/bounty-status.ts`, `bounties/admin/bounty-admin.service.ts` |
| 트랜잭션 + `FOR UPDATE` — 제출/심사 레이스 컨디션 방지 | `submissions.service.ts` |
| 닉네임 unique 인덱스 — 중복검사~저장 레이스의 최종 방어선 (23505 → 409) | `users.service.ts` |
| 금액 정수 저장 (DECIMAL(78,0)) — 부동소수점 오차 원천 차단 | `0006` |
| 감사 로그 — 민감정보(토큰 원문, private key) 기록 금지 원칙 명시 | `0009` |
| `.env` 커밋 차단 | `.gitignore` |

## 🚧 Phase 1 구현 시 필수 (구글 OAuth / 지갑 검증 구현할 때)

- [x] **OAuth `state` 파라미터** — 서명된 10분 JWT state(`p:'gstate'`)로 CSRF 방지 (`auth.service.ts` issueOauthState/verifyOauthState)
- [x] 콜백에서 토큰을 **URL로 FE에 넘기지 않음** — 60초 일회용 로그인 코드(해시만 저장)를 fragment로 전달, `POST /auth/exchange`에서 세션 발급 (`0013`, `auth.controller.ts`)
- [x] **PKCE(S256)** — `/auth/google`은 `codeChallenge` 필수, 코드 교환 시 `codeVerifier` 검증 (`INVALID_CODE_CHALLENGE` / `INVALID_LOGIN_CODE`)
- [x] **refresh token 회전** — 조건부 UPDATE로 구 토큰 선점 폐기, 재사용 거부 (`auth.service.ts` refresh)
- [x] **rate limit** — 전역 IP 120/min + `/auth/google` 20, `/auth/exchange`·`/auth/refresh` 10, `check-nickname` 30 (`app.module.ts`, 각 컨트롤러)
  - [ ] 저장소가 인스턴스별 in-memory — 레플리카 2대 이상으로 늘리기 전에 공유 저장소(Redis/pg)로 전환 (`TODO(scale)`)
- [x] Google `id_token` 서명 검증 — Google JWKS (`google-id-token.verifier.ts`)
- [ ] **Cloudflare Turnstile 검증** — 가입(첫 로그인) 요청에서 서버측 siteverify 호출 (기획 확정 사항). `TURNSTILE_SECRET_KEY`는 아직 어떤 코드도 읽지 않는다 — `.env.example` 맨 아래 "계획만 있는 값" 주석에만 있고 `.railway/railway.ts`에도 없다. 구현 시 `ConfigService`로 읽고 `.env.example` 본문으로 올릴 것
- [x] 지갑 서명 검증 시: challenge의 `user_id`·`wallet_address` 일치 확인, `used_at` 마킹(재사용 차단), 서명자 pubkey → 주소 유도 일치 확인 (`wallets.service.ts`, `common/crypto/*`)
- [x] 만료된 `wallet_verification_challenge` 주기 삭제 (크론) — 매시 `MaintenanceService`, 발급 시 같은 지갑의 미사용 challenge 정리
- [x] 로그에 이메일·토큰 등 PII/비밀 출력 금지 — `onboardingLog`는 길이/불리언/id만, 전역 필터·인터셉터는 경로/상태/에러명만 기록

## 🚧 Phase 2~3 구현 시 필수

- [ ] 파일 업로드 (첨부): MIME/확장자 화이트리스트, 크기 제한(`platform_setting`), Supabase Storage **signed URL** 사용, 공개 버킷 금지. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`는 아직 읽는 코드가 없다 (`.env.example` "계획만 있는 값" 주석) — 현재 이미지는 `POST /admin/media`가 DB(`media_asset`)에 저장
- [ ] payout 자동화 도입 시: 송금 전 잔액 확인, tx 브로드캐스트와 DB 상태 갱신 사이 크래시 복구 로직 (BROADCASTING 상태 재조회)
- [ ] 마스터 지갑 키: 호스팅 secret/Vault 외 저장 금지, 레포·로그·에러 메시지에 노출 금지. **민팅 권한만** 부여 (보상 자금 지갑과 분리 — 기획 확정)
  - [x] `nft_job.last_error`/워커 로그에서 니모닉 redaction + 500자 절단 (`nft-job.worker.ts`)

## ⚠️ 운영 전 결정/조치 필요

- [ ] **DB TLS 인증서 검증 활성화** — 코드는 준비됨: 운영 env에 `DATABASE_CA_CERT`(Supabase CA PEM, `\n` 이스케이프 가능)를 넣으면 `ssl.ca` + `rejectUnauthorized: true`. 비워 두면 기존처럼 검증 생략(MITM에 취약)이므로 **운영 배포 전 반드시 설정** (`.env.example`, `database-ssl.ts`). `.railway/railway.ts`에 `DATABASE_CA_CERT: preserve()`로 자리를 잡아 두었고, `NODE_ENV=production`에서 비어 있으면 **기동은 하되 부팅 로그에 warn 1회** — 인증서가 아직 발급/배포되지 않은 상태를 막지 않기 위해 거부하지 않는다 (`database.service.ts`)
- [x] Vercel preview 오리진은 `CORS_ORIGINS` / `AUTH_ALLOWED_REDIRECT_ORIGINS`에 **브랜치 고정 별칭을 정확한 항목**으로 넣는다 (`https://ninjalabsfe-git-develop-<team>.vercel.app`) — 또는 커스텀 preview 도메인을 쓴다. 공용 호스팅 접미사(vercel.app, netlify.app, pages.dev, github.io, railway.app, herokuapp.com, onrender.com, fly.dev, web.app, firebaseapp.com) 위의 와일드카드는 `*`의 **위치와 무관하게 안전하지 않다** — `https://ninjalabsfe-*-<team>.vercel.app`도 공격자가 `ninjalabsfe-evil-<team>`이라는 프로젝트를 만들면 통과해 `returnTo`로 로그인 코드를 받아갈 수 있다. `OriginAllowlist`는 등록 가능 도메인(마지막 두 레이블, 대소문자·끝의 점·포트 무시)이 그 접미사인 와일드카드 항목을 **전부 거부**한다 — 기동 시 `error` 로그 후 목록에서 제외되어 어떤 오리진도 허용하지 않는다 (`origin-allowlist.spec.ts`)
- [x] rate limit이 IP 기준 — 프록시/로드밸런서 뒤에서는 `TRUST_PROXY`(홉 수) 필요. `.railway/railway.ts`가 `TRUST_PROXY=1`, `NODE_ENV=production`을 넣는다. production에서 미설정이면 `main.ts`가 1홉으로 보고 `warn`, 명시적 `0`/비정수면 기동을 거부한다 (`bootstrap-checks.ts`) — 프록시가 2홉 이상이면 반드시 명시
- [ ] 어드민 계정 부트스트랩 — `is_admin`은 DB에서 수동 지정. 지정 절차·권한자를 운영 문서에 명시
- [ ] 멀티시그 서명자 구성(2-of-3 제안)과 서명자 목록 — 오프체인 정책 문서화
- [ ] `npm audit` CI 통합 + 의존성 업데이트 주기 — 2026-10 기준 `@nestjs/*` 11.2.7 / `@nestjs/config` 4.0.4, `npm audit --omit=dev` high/critical 0 (axios·follow-redirects는 `@injectivelabs/sdk-ts` 경유 transitives, patch로 해결)
- [ ] Supabase `service_role` 키는 백엔드에서만 사용, FE·레포 노출 금지
