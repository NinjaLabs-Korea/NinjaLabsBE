# NinjaLabs Backend API 계약 v0.1

> FE 레포의 `docs/auth-api-contract.md`(바인딩 계약)와 맞춰가는 백엔드 측 명세.
> FE 팀 리뷰 후 확정한다. Base URL: `https://api.ninjalabs.xyz` (예정) / 로컬 `http://localhost:4000`

## 공통 규칙

- 인증: `Authorization: Bearer <accessToken>` 헤더. access token은 JWT(15분), refresh token으로 재발급.
- 에러 응답: `{ "statusCode": number, "message": "ERROR_CODE", "error": "..." }` (NestJS 기본 포맷)
- 시간: ISO 8601 (UTC, timestamptz)
- 토큰 금액: 최소 단위 정수 **문자열** (`"1000000000000000000"` = 1 INJ). JS number 정밀도 문제로 문자열 고정.
- 페이지네이션: `?page=1&pageSize=12` → `{ items, page, pageSize, total }`. `page`는 1 이상 정수, `pageSize`는 1~50 정수 — 그 외(`page=abc`, `pageSize=0`)는 `400`.
- 요청 본문/쿼리에 DTO에 없는 필드가 있으면 `400`(`forbidNonWhitelisted`). FE 페이로드와 DTO를 1:1로 유지한다.
- 자유 텍스트 상한(초과 시 `400`): 닉네임 2~50자 — 유니코드 문자/숫자와 `_ . -`만, 공백 불가(앞뒤 공백은 trim) · bio 1000 · 지원 `message` 4000 · 제출 `description` 8000 · 심사 `comment`/`note` 2000 · 공지 `title` 200/`summary` 500/`body` 50000 · 하이라이트 `title` 200/`description` 2000 · 바운티 `title` 200/`summary` 500/`description` 50000/`requirements`·`evaluationCriteria` 20000/`sponsorName` 100 · 에이전트 `name` 100(trim 후 1~100, FE 입력 `maxLength`와 동일)/`description` 1000. **수정(PATCH) DTO**(`/admin/bounties/:id`, `/admin/notices/:id`, `/admin/highlights/:id`)는 상한이 생성의 **2배** — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로 규칙 강화 이전에 저장된 행이 편집 불가가 되지 않게 한다 (`title`류 컬럼은 DB `VARCHAR(200)`이 최종 상한).
- URL 필드는 `http(s)://`만 받는다 (`javascript:` 등 `400`). 이미지 필드(`thumbnailUrl`, `imageUrl`, `coverImageUrl`)는 `POST /admin/media`가 돌려주는 상대 경로 `/media/<uuid>`도 받는다. 하이라이트 `linkUrl`은 사이트 내부 경로(`/bounties/<slug>`)도 받는다. `externalUrl`/`portfolioUrl`/`submissionUrl`/`repositoryUrl`은 절대 http(s) URL만. **수정(PATCH) DTO의 URL 필드는 완화 규칙**: http(s) 절대 URL, `/` 하나로 시작하는 아무 사이트 경로(레거시 `/uploads/x.png` 등), 스킴 없는 레거시 bare host(`cdn.example/x.png` — FE가 바뀌지 않은 값을 그대로 되보내므로 막으면 그 행의 모든 수정이 `400`이 된다; 실행 불가하고 FE는 그리지 않는다)를 받고, `javascript:`/`data:`/`vbscript:`·프로토콜 상대(`//host`)·제어 문자·공백/역슬래시는 `400`. 생성 DTO는 bare host를 계속 거부한다.
- tx 해시(`txHash`): 32바이트 hex, `0x` 접두사 선택 (`^(0x)?[0-9a-fA-F]{64}$`) — 그 외 `400 INVALID_TX_HASH`. 서버는 `0x`+소문자로 정규화해 저장한다. 입금 해시는 이미 다른 보상에 기록돼 있으면 `409 TX_HASH_ALREADY_USED`. 송금 해시는 **다른 바운티**의 PAID payout에 이미 기록돼 있으면 `409 TX_HASH_ALREADY_USED`이고, **같은 바운티** 안에서는 여러 payout에 같은 해시를 기록할 수 있다 (멀티시그 tx 하나로 여러 수상자에게 송금).
- 읽기(공개) 엔드포인트는 로그인 불필요 — "행동" 시점에만 인증 요구 (기획 원칙)
- CORS/`returnTo` 허용 오리진은 정확한 오리진, 또는 팀이 소유한 도메인에서만 호스트 레이블 하나의 `*` 와일드카드를 받는다 (`CORS_ORIGINS`, `AUTH_ALLOWED_REDIRECT_ORIGINS`). Vercel preview는 브랜치 고정 별칭을 **정확한 항목**으로 넣는다 (`https://ninjalabsfe-git-develop-<team>.vercel.app`) — 또는 커스텀 preview 도메인. vercel.app 같은 공용 호스팅 접미사 위의 와일드카드는 `*`의 위치와 무관하게(`https://ninjalabsfe-*-<team>.vercel.app` 포함) 아무나 일치하는 호스트를 등록할 수 있어 **거부된다** — 기동 시 error 로그 후 목록에서 제외되어 어떤 오리진도 허용하지 않는다 (docs/security.md).

## 인증 (Auth)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/auth/google` | - | `codeChallenge`(S256, 필수), `returnTo`, `trace`, `turnstileToken`(`TURNSTILE_SECRET_KEY` 설정 시 필수) → 구글 동의 화면. 봇 방지 실패 `400 TURNSTILE_FAILED`, Cloudflare 불통 `503 TURNSTILE_UNAVAILABLE` (아래 "Turnstile") |
| GET | `/auth/google/callback` | - | Google code 교환 → FE `/auth/callback#loginCode=...` |
| POST | `/auth/exchange` | - | `{code, codeVerifier}` → `{accessToken, refreshToken}`; `Cache-Control: no-store, private`. **쿠키 모드**(`X-Ninja-Session: cookie`): `Set-Cookie: ninja_rt=…` + 본문 `{accessToken}` (아래 "refresh 쿠키 모드") |
| POST | `/auth/refresh` | - | **쿠키 모드**: 본문 `{}`(또는 없음) + `ninja_rt` 쿠키 → `{accessToken}` + 새 `Set-Cookie`. **본문 모드(deprecated)**: `{refreshToken}` → `{accessToken, refreshToken}` (회전). `Cache-Control: no-store, private`. **재사용 유예 30초**: 방금 회전된 구 토큰이 30초 안에 다시 오면(멀티탭 레이스) 401 대신 이긴 쪽과 **같은 `refreshToken`**(+ 새로 서명한 `accessToken`)을 돌려주고 다시 회전하지 않는다 — 두 탭 모두 그 토큰을 쓰면 된다. 30초가 지났거나 그 후속 토큰이 이미 회전/폐기됐으면 재사용 감지로 보고 `401 INVALID_REFRESH_TOKEN` + 그 토큰에서 파생된 세션 사슬 전체 폐기(재로그인 필요). 정지/삭제된 유저는 항상 401 |
| POST | `/auth/logout` | - | **쿠키 모드**: 쿠키의 세션 폐기 + 쿠키 삭제(`Max-Age=0`) → 204. **본문 모드(deprecated)**: `{refreshToken}` → 204 |
| GET | `/auth/me` | ✅ | 현재 유저 프로필 + 온보딩/지갑 상태 |

### refresh 쿠키 모드 (2026-10-24 결정 — FE는 이 계약으로 구현)

FE는 `/api/auth/*`를 Next.js rewrite로 BE `/auth/*`에 프록시한다 — 브라우저가 보는 것은 FE 호스트의 `/api/auth/...`이므로 쿠키는 FE 호스트의 first-party 쿠키다.

- **요청별 옵트인**: 헤더 `X-Ninja-Session: cookie`(값은 대소문자·앞뒤 공백 무시). 이 헤더가 없으면 쿠키는 **무시**되고 본문 모드다(그대로 동작 — 옛 탭/스크립트 호환, **deprecated**).
- **쿠키**: `Set-Cookie: ninja_rt=<refresh>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=<JWT_REFRESH_TTL 초, 기본 1209600>` — `Domain` 없음. 값은 base64url 64자.
- `POST /auth/exchange`: 쿠키를 심고 본문은 `{accessToken}` (`refreshToken` 없음 — 그 밖의 필드가 생기면 그대로 둔다).
- `POST /auth/refresh`: 본문 `{}`(또는 본문 없음) — `ninja_rt`를 읽어 회전하고 새 토큰으로 쿠키를 다시 심는다 → `{accessToken}`. 30초 재사용 유예도 같다(유예 응답은 이긴 쪽과 같은 토큰을 쿠키로). 
  - **레거시 이전(1회)**: 헤더와 함께 본문 `refreshToken`이 오면(localStorage에 남은 토큰) 본문 토큰을 쓰고 결과를 쿠키로 심는다. 이후 FE는 localStorage 토큰을 지운다.
  - 쿠키가 없으면 `401 INVALID_REFRESH_TOKEN`(쿠키 변경 없음). **쿠키에서 읽은** 토큰이 401이면 쿠키를 지운다(`Max-Age=0`).
- `POST /auth/logout`: 쿠키(와 본문에 함께 온 레거시 토큰)의 세션을 폐기하고 `Set-Cookie: ninja_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0` → 204. 토큰이 없어도 204.
- **CSRF**: 쿠키를 쓰는 요청은 커스텀 헤더가 **필수** — 교차 사이트 폼은 헤더를 붙일 수 없고, 교차 출처 JS는 CORS preflight(`CORS_ORIGINS` 허용 목록)에서 막힌다. `SameSite=Strict`는 이중 방어 (docs/security.md).
- **본문 모드에서** `refreshToken`이 빠지면 예전과 같은 `400 ["refreshToken should not be empty", "refreshToken must be a string"]`.
- **한도**: `/auth/refresh`는 제시된 refresh 토큰(쿠키 또는 본문)의 **해시별 10/min**, `/auth/exchange`는 로그인 코드 해시별 10/min (초과 시 429 + `Retry-After-auth-token`). Vercel 프록시 뒤 사용자들이 공유 egress IP 하나에 묶여 서로의 refresh를 막지 않게 한 것이다. IP 기준 거친 한도는 이 두 라우트에서 IP당 **600/min**(전역 120/min을 덮어씀 — 운영 트래픽이 Vercel egress IP 몇 개로 모인다, 초과 시 `Retry-After`)이다. 다른 라우트는 120/min.

로그인 시 FE는 탭의 `sessionStorage`에 랜덤 verifier를 저장하고 SHA-256/base64url
challenge만 `/auth/google`에 보낸다. BE는 challenge를 서명된 OAuth state에 연결한다.
콜백 URL에는 access/refresh token을 넣지 않는다. 대신 60초 동안 유효한 일회용 코드를
전달하며 DB에는 코드 해시만 저장한다. FE는 URL fragment를 먼저 지운 뒤 코드와 verifier를
POST 본문으로 교환한다. 검증에 성공한 코드는 세션 발급과 같은 트랜잭션에서 소비되므로
재사용할 수 없다. 만료·다른 verifier·비활성 계정은 `401 INVALID_LOGIN_CODE`로 거부한다.

배포 순서(완료): **새 FE 배포 → `0013_oauth_login_codes.sql` 마이그레이션 적용 → 새 BE 배포**.
2026-10-22부터 FE는 URL fragment의 access/refresh token을 더 이상 수거하지 않는다 (링크로 세션을
심는 공격면 제거). BE는 challenge가 없는 로그인 시작 요청을 `401 INVALID_CODE_CHALLENGE`로 거부한다.

### Turnstile (로그인 봇 방지)

`TURNSTILE_SECRET_KEY`가 설정된 배포에서 `GET /auth/google`은 `turnstileToken` 쿼리(Cloudflare Turnstile 위젯이 브라우저에 준 토큰)를
state 발급 **전에** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`(`secret`, `response`, `remoteip`=클라이언트 IP, 5초 제한)로 검증한다.

| 상황 | 응답 |
|---|---|
| 토큰 없음/빈 값/2048자 초과/배열 | `400 TURNSTILE_FAILED` (siteverify 호출 없음) |
| siteverify `success:false` (위조·만료·재사용 — 토큰은 1회용, 300초) | `400 TURNSTILE_FAILED` |
| 네트워크 오류·5초 초과·비2xx·JSON 아님·`invalid-input-secret`/`missing-input-secret`/`internal-error` | `503 TURNSTILE_UNAVAILABLE` |
| `TURNSTILE_SECRET_KEY` 미설정 | 검사 생략 — `turnstileToken`이 와도 무시 (production이면 기동 시 warn) |

이 라우트는 브라우저 전체 페이지 이동이라 400/503은 JSON 본문 그대로 보인다. FE는 위젯 토큰을 받은 뒤에만 이동하고(`NEXT_PUBLIC_TURNSTILE_SITE_KEY`),
만료되면 위젯을 다시 돌린다. FE↔BE 키 짝: FE site key가 있는데 BE secret이 없으면 토큰이 무시될 뿐 로그인은 된다. 반대(BE secret만)는 모든 로그인이 400이므로
**FE를 먼저 배포**한다.

`/auth/me` 응답 (FE 헤더/온보딩 분기에 필요한 모든 상태):

```json
{
  "id": "uuid",
  "nickname": "ryan",
  "email": "a@b.com",
  "bio": "...",
  "tags": ["DEV"],
  "onboardingStep": 4,
  "onboardingCompleted": true,
  "isAdmin": false,
  "isMember": false,
  "wallet": { "address": "inj1...", "verifiedAt": "..." } ,
  "nft": { "status": "MINTED", "tokenId": "..." }
}
```

## 온보딩 / 유저

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/users/check-nickname?nickname=` | - | `{available: boolean}` — 즉시 중복 검증 |
| POST | `/users/me/profile` | ✅ | `{nickname, bio, tags[]}` 전부 필수 (온보딩 3단계). 닉네임 2~50자, 유니코드 문자/숫자와 `_ . -`, **처음과 끝은 문자/숫자**, 예약어 `me`/`check-nickname`/`admin`/`new`/`edit`와 탈퇴 익명화 접두사 `withdrawn_`(대소문자 무관) 불가 — `check-nickname`도 예약어에 `available: false` |
| POST | `/users/me/complete-onboarding` | ✅ | 온보딩 완료 플래그 |
| DELETE | `/users/me` | ✅ | **회원 탈퇴** `{confirmNickname}`(지금 닉네임, 앞뒤 공백·대소문자 무시) → 200 `{ok: true}`. 400 `CONFIRM_NICKNAME_MISMATCH`, 409 `WITHDRAWAL_BLOCKED_OPEN_PAYOUTS`(본인/내 에이전트 제출 또는 내 지갑으로 가는 payout 중 `PAID`/`CANCELLED`/`FAILED`가 아닌 것이 있음), 404 `USER_NOT_FOUND`(이미 탈퇴·정지). 한 트랜잭션: user `WITHDRAWN`+`deleted_at`, `google_id`/`email`에 `deleted:<ms>:` 프리픽스(같은 구글 계정 재가입 = 새 계정), 닉네임 `withdrawn_<8hex>`로 익명화·bio/링크/태그/멤버 플래그 제거, refresh 세션 전부 폐기, 지갑 연결 해제, 소유 에이전트·키 `REVOKED`, PENDING 지원과 심사 전 제출(`SUBMITTED`/`RESUBMITTED`/`IN_REVIEW`/`REVISION_REQUESTED`) `WITHDRAWN`, 감사 `USER_WITHDRAWN`(+에이전트마다 `AGENT_REVOKED`). 승인/반려된 제출·payout·NFT 기록은 남는다. 동시에 들어온 `requestPayout`과는 수령자 유저 행 잠금으로 직렬화된다(탈퇴가 먼저면 404, 지급 요청이 먼저면 409). 쿠키 모드 FE는 이어서 `POST /auth/logout`(204, 멱등)으로 쿠키를 지운다. 5회/분 (2026-10-24) |
| GET | `/users/:nickname` | - | 공개 프로필: 기본정보 + 완료 바운티 + 에이전트 + 실제 부모/완료 NFT 상태·token ID·mint tx |

- `completedBounties[]`는 이 유저 **또는 유저 소유 에이전트**의 APPROVED 제출이 있는 바운티(soft delete 제외, Hall of Fame `builders`와 같은 기준).
  `rewards[]`는 바운티에 걸린 보상이 아니라 **그 제출에 실제 PAID된 payout** 목록이며 원소 모양은 `{ amount: "<최소 단위 정수 문자열>", symbol }`로 유지된다 (지급 전이면 `[]`).
  같은 행에 `postedRewards[]`(바운티에 **걸린** 보상 `bounty_reward` 목록, 같은 원소 모양 — 보상이 없으면 `[]`)와
  `payoutStatus: 'PAID' | 'PENDING' | 'NONE'`이 함께 온다 — `NONE` 보상 없는 바운티, `PAID` 이 제출의 payout이 전부 PAID, 그 외 `PENDING`(지급 전·진행 중).
  `/submissions/me`의 `payment_status`와 같은 규칙. FE는 `payoutStatus === 'PENDING'`이면 `rewards`의 0 대신 `postedRewards`를 "지급 대기"로 보여준다.
  기존 필드(`id`, `title`, `category`, `completed_at`, `rewards`)는 그대로다.

## 지갑 (온보딩 2단계)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/wallets/challenge` | ✅ | `{address}` → `{id, nonce, message, expires_at}` (DB 행 그대로 — snake_case, 5분 만료, 1회용). FE는 `message`만 읽어 서명한다 |
| POST | `/wallets/verify` | ✅ | Keplr/Leap: `{address, signature, publicKey}` / EVM: `{address, signature}` → 검증 성공 시 지갑 저장 + NFT 민팅 잡 등록 |
| GET | `/wallets/me` | ✅ | 내 대표 지갑 (없으면 null — 미연결 상태) |

- 검증 실패/스킵 → FE는 그대로 온보딩 진행 (지갑은 null). 에러코드: `INVALID_SIGNATURE`, `CHALLENGE_NOT_FOUND`(challenge 미발급), `CHALLENGE_EXPIRED`(만료/사용됨), `WALLET_ALREADY_LINKED`
- Keplr/Leap: challenge의 `message`를 `signArbitrary(chainId, address, message)`로 서명.
  응답의 `signature`(base64)와 `pub_key.value`(base64)를 그대로 `signature`, `publicKey`로 전송.
  서버는 ADR-36 sign doc을 재구성해 keccak256/secp256k1로 검증하고 공개키→주소 일치도 확인한다.
- MetaMask 등 EVM 지갑: challenge의 `message`를 EIP-191 `personal_sign`으로 서명하고
  0x `address`와 hex `signature`를 전송한다. 서버는 서명자를 복구한 뒤 대응되는 `inj1` 주소로
  정규화해 저장하므로 CW-721 NFT의 수신 주소로도 사용할 수 있다.

## 바운티 (공개 읽기)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/bounties?page=&category=&status=` | - | 목록 (DRAFT/FUNDING_PENDING 비노출) + 보상, `cover_image_url`, `submission_mode` |
| GET | `/bounties/:id` | - | 상세 + 보상 + 첨부 — 명시적 컬럼만(`bounties.service.ts` PUBLIC_DETAIL_COLUMNS). `created_by`·`sponsor_user_id`·`deleted_at` 같은 내부 컬럼은 내보내지 않는다 |

## 바운티 참여 (행동 — 인증 필요)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/bounties/:id/applications` | ✅ | 지원형 지원 `{message, portfolioUrl?}` → 201 `{id, status, applied_at}`. 이미 PENDING/APPROVED/REJECTED 지원이 있으면 409 `ALREADY_APPLIED`. **본인이 철회한(WITHDRAWN) 지원이 있으면 같은 행을 다시 연다** — 같은 `id`, `status: PENDING`, 새 `message`/`portfolioUrl`(생략 시 `null`), `applied_at` 갱신, 심사 필드(`reviewed_by`/`reviewed_at`/`review_note`) 초기화, 감사 `APPLICATION_REAPPLIED`. 새 지원과 같은 검사(OPEN·마감 전·제출 방식)를 통과해야 한다 (2026-10-24 결정). 에이전트 경로 `/agent-api/v1/bounties/:id/applications`도 동일 |
| GET | `/applications/me` | ✅ | 내 지원 내역 (FE `/applications` 페이지) — 본인 건 + **내 에이전트가 낸 건** 포함 |
| POST | `/applications/:id/withdraw` | ✅ | 지원 철회 (PENDING만) — 본인 지원 또는 내 에이전트의 지원 |
| POST | `/bounties/:id/submissions` | ✅ | 제출/재제출 `{submissionUrl, description, repositoryUrl?, commitSha?}` |
| GET | `/submissions/me` | ✅ | 내 제출 내역 — 본인 건 + **내 에이전트가 낸 건** 포함 |

`/applications/me`, `/submissions/me`의 모든 행에 `agent: { id, name } | null`이 들어간다 (사용자가 직접 낸 건은 `null`).
기존 필드와 정렬(최신순)은 그대로다.

제출 검증 규칙 (서버가 강제, FE는 안내만):

- 지원형인데 APPROVED 지원서 없음 → 403 `APPLICATION_NOT_APPROVED`
- 마감 후 (REVISION_REQUESTED 아님) → 400 `DEADLINE_PASSED`
- APPROVED/REJECTED 확정 후 → 409 `SUBMISSION_FINALIZED`
- `submission_mode=AGENT`에 사용자 JWT 경로 호출 → 400 `AGENT_SUBMISSION_REQUIRED`
- `submission_mode=DIRECT`에 Agent API key 경로 호출 → 400 `DIRECT_SUBMISSION_REQUIRED`

## 커뮤니티 (공개 읽기)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/notices?page=&category=` | - | 공지/소식 목록 |
| GET | `/notices/:id` | - | 상세 (삭제/비공개 → 404, FE는 목록으로 안내) |
| GET | `/members` | - | 공식 멤버 리스트 (역할·링크 포함, display_order 정렬) |
| GET | `/hall-of-fame` | - | 큐레이션 하이라이트 |
| GET | `/hall-of-fame/stats` | - | 자동 집계 지표 `{completedBounties, builders, completionNfts, sponsors, paidTotals}` (완료 바운티/빌더/NFT/스폰서 수 + 지급 완료 보상 총액). `paidTotals: [{symbol, tokenType, decimals, amount}]` — status `PAID` payout만 `(upper(display_symbol), token_type)`별로 합산, 삭제된 바운티 제외, `amount`는 base unit 정수 **문자열**, `decimals`는 서버가 아는 토큰만(INJ 18, USDC 6; 그 밖은 `null`), 심볼 순 정렬, 지급 이력이 없으면 `[]`. 서버 인스턴스별 인메모리 캐시 **60초** — 완료 전이/민팅 직후 최대 1분 늦게 반영된다 (`highlights.service.ts`) |

## 에이전트

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/agents` | ✅ | 등록 (PENDING_VERIFICATION) EVM: `{name, description?, walletAddress: "0x..."}` / ADR-36: `{name, description?, publicKey, walletAddress: "inj1..."}` → `{agentId, status, verificationMessage}`. 같은 지갑/공개키의 **내** `REVOKED` 에이전트가 있으면 그 행은 그대로 두고(soft delete 없음 — `/agents/me`와 프로필의 이력 유지) 새 행을 등록한다 (유니크 인덱스가 REVOKED 행을 무시한다, 0014). 내 `PENDING_VERIFICATION` 행이 있으면 그 행을 그대로 돌려준다. **남의** `PENDING_VERIFICATION` 행은 소유 증명이 아니므로(증명은 verify의 서명) 등록 후 **24시간이 지났으면 버려진 것으로 보고 soft delete 후 진행**, 24시간 이내면 409. 남의 `ACTIVE`/`REVOKED` 에이전트면 409 `AGENT_KEY_OR_WALLET_ALREADY_REGISTERED` |
| POST | `/agents/:id/verify` | ✅ | `{signature}` — 에이전트 지갑 서명 검증 → ACTIVE + **API key 원문 1회 반환** `{agentId, status, apiKey, expiresAt}` |
| GET | `/agents/me` | ✅ | 내 에이전트 목록 (`REVOKED` 에이전트 포함, soft delete된 행만 제외) — 에이전트당 1행, 최신 키의 `key_prefix`·`key_expires_at`(ISO\|null)·`key_status`(`ACTIVE`\|`REVOKED`\|`EXPIRED`\|null) |
| POST | `/agents/:id/keys/rotate` | ✅ | 기존 ACTIVE 키 전부 폐기 + 새 키 발급 → `{agentId, apiKey, expiresAt}` (원문 1회). 404 `AGENT_NOT_FOUND`, 409 `AGENT_NOT_ACTIVE` |
| POST | `/agents/:id/revoke` | ✅ | 에이전트 + 모든 키 REVOKED → `{agentId, status: 'REVOKED'}` (멱등). 404 `AGENT_NOT_FOUND` |
| GET | `/agent-api/v1/me` | Agent API key | 인증된 에이전트 자기 정보 (`Authorization: Bearer nj_...`) |
| POST | `/agent-api/v1/bounties/:id/applications` | Agent API key | 에이전트 전용 지원형 신청 |
| POST | `/agent-api/v1/bounties/:id/submissions` | Agent API key | 에이전트 전용 제출/재제출 |

- 검증 방법: 등록 응답의 `verificationMessage`를 **에이전트별 전용 지갑 키**로 서명한다.
  `0x` 주소는 EIP-191 `personal_sign` hex 서명을 제출하며 서버가 공개키를 복구해 저장한다.
  `inj1` 주소는 ADR-36 `signArbitrary`의 base64 서명과 등록 시 public key를 사용한다.
- API key 만료 90일 (decisions.md). 에러코드: `AGENT_NOT_FOUND`, `AGENT_ALREADY_VERIFIED`, `INVALID_SIGNATURE`, `AGENT_KEY_OR_WALLET_ALREADY_REGISTERED`(409)
- Google 로그인 콜백에서 Google JWKS를 못 받아오면 BE는 내부적으로 503 `GOOGLE_UNAVAILABLE`로 구분하지만, FE로는 다른 실패와 같은 `/auth/callback#error=AUTH_FAILED`로 리다이렉트된다.

에이전트 전용 REST API 인증 및 지원/제출 계약은 `docs/agent-api.md`를 따른다.

## 어드민 (AdminGuard — is_admin 필수)

| Method | Path | 설명 |
|---|---|---|
| GET | `/admin/users?q=&page=` | 이메일/닉네임 유저 검색 — 30건/페이지(기본 `page=1`), 응답은 배열. `q`가 비면 최신 가입 30명. `%`/`_`는 문자 그대로 검색 |
| POST | `/admin/users/:id/member` | 멤버 지정/해제 `{isMember, role?, displayOrder?}` |
| POST | `/admin/media` | JPEG/PNG/WebP 이미지 업로드 (`multipart/form-data`, `file`, 최대 5 MiB) → `{id, url}` |
| GET | `/admin/bounties` | 삭제되지 않은 전체 바운티 목록 (DRAFT 포함) |
| POST | `/admin/bounties` | 바운티 등록 (`submissionMode`, `coverImageUrl?`; 보상 포함 시 FUNDING_PENDING으로) |
| PATCH | `/admin/bounties/:id` | 바운티 기본 정보 수정 — 접수 중(DRAFT/FUNDING_PENDING/OPEN)인 바운티의 마감을 과거로 **옮기면** 400 `DEADLINE_IN_PAST`. 저장된 마감을 그대로(또는 1분 미만 차이 — `datetime-local` 왕복으로 초가 잘려도) 되보내는 것은 통과하고, 접수가 끝난 상태(SUBMISSION_CLOSED/IN_REVIEW/COMPLETED/CANCELLED)에서는 마감을 검사하지 않는다(제목/설명만 고치는 편집 허용). `maxWinners` < 승인된 제출 수: 400 `MAX_WINNERS_BELOW_APPROVED` |
| DELETE | `/admin/bounties/:id` | 바운티 soft delete → `{id}`. 멀티시그에 아직 묶인 돈이 있으면 **409 `BOUNTY_HAS_OPEN_FUNDS`** — 보상이 `REFUND_PENDING`이거나, `FUNDED`/`PARTIALLY_PAID`/`PAID`인데 PAID 합계가 배정 상한 `LEAST(amount, deposited_amount)`에 못 미치거나, 종료 상태(`PAID`/`CANCELLED`/`FAILED`)가 아닌 payout이 있을 때. 보상이 `DEPOSIT_PENDING`/`REFUNDED`/`CANCELLED`이거나 전액 지급된 `PAID`뿐이면 허용 (2026-10-24 결정). 검사는 바운티 행 잠금 아래 |
| POST | `/admin/bounties/:id/transition` | 상태 전환 `{to}` — 허용 전이만 |
| POST | `/admin/applications/:id/review` | 지원 승인/거절 `{decision, note?}` |
| POST | `/admin/submissions/:id/review` | 제출 심사 `{decision: START_REVIEW\|REQUEST_REVISION\|APPROVE\|REJECT, comment?}` |
| POST | `/admin/rewards/:id/confirm-deposit` | 선입금 확인 `{txHash, depositedAmount}` — `txHash` 규칙은 공통 규칙 참조 (`400 INVALID_TX_HASH`, `409 TX_HASH_ALREADY_USED`) |
| POST | `/admin/payouts` | 지급 요청 생성 `{rewardId, submissionId, amount}` (멱등). 보상이 `PAID`여도 여유분(배정 상한 − 취소 아닌 payout 합계)이 남아 있으면 받고 보상은 `PARTIALLY_PAID`로 돌아간다(첫 지급 뒤 `maxWinners`를 올린 경우); 여유분이 없으면 `400 PAYOUT_EXCEEDS_AVAILABLE_REWARD`. **배정 상한 = `LEAST(게시 금액 amount, 입금액 deposited_amount)`** — 초과 입금은 상한을 올리지 않는다 (2026-10-24 결정) |
| POST | `/admin/payouts/:id/approve` | 멀티시그 승인 완료 표시. **2인 규칙**: 그 payout을 요청한 운영자(`payout.requested_by`)가 승인하면 **403 `PAYOUT_SELF_APPROVAL`** — 다른 운영자가 승인해야 한다(`approved_by` 저장, 감사 `PAYOUT_APPROVED`). 운영자 1인 배포용 탈출구 `PAYOUT_ALLOW_SELF_APPROVAL=true`이면 허용하되 warn 로그 + 감사 `PAYOUT_SELF_APPROVED`. 승인 가능 상태(`REQUESTED`/`AWAITING_MULTISIG_APPROVAL`)가 아니면 404 `PAYOUT_NOT_FOUND_OR_WRONG_STATUS`(자기 승인 검사보다 먼저) |
| POST | `/admin/payouts/:id/paid` | 송금 완료 기록 `{txHash}` — `400 INVALID_TX_HASH`; 다른 바운티의 PAID payout에 이미 쓰인 해시면 `409 TX_HASH_ALREADY_USED`, 같은 바운티의 다른 payout과 같은 해시는 허용(한 tx로 여러 수상자 송금) |
| GET | `/admin/notices` | 초안 포함 전체 공지 목록 |
| POST | `/admin/notices` | 공지 작성 `{..., publish?}` |
| PATCH | `/admin/notices/:id` | 공지 수정/발행 상태 변경 |
| DELETE | `/admin/notices/:id` | 공지 soft delete |
| GET | `/admin/highlights` | 비공개 포함 전체 하이라이트 목록 |
| POST | `/admin/highlights` | 하이라이트 등록 |
| PATCH | `/admin/highlights/:id` | 하이라이트 수정/발행 상태 변경 |
| DELETE | `/admin/highlights/:id` | 하이라이트 삭제 |
| GET | `/admin/bounties/:id/operations` | 운영 화면 한 번에 필요한 데이터 — 아래 "Admin bounty operations" 참조 (2026-10-24: 신원·수령 지갑·요청자/승인자·`requested_by_me`·`policy`·`lifecycle.blockerDetails`/`allowedTransitions` 추가) |
| GET | `/admin/nft-jobs?status=FAILED\|PENDING\|PROCESSING&page=` | NFT 잡 콘솔 → `{ items, page, pageSize: 30, total }` (기본 `status=FAILED`, `updated_at` 최신순). 항목: `id, nft_id, job_type, status, retry_count, last_error, scheduled_at, started_at, processed_at, created_at, updated_at, nft_type, nft_status, bounty_id, bounty_title, submission_id, owner_user_id, owner_nickname, owner_wallet_address`. 그 밖의 `status`(SUCCEEDED/CANCELLED/소문자)나 `page`<1 → `400` |
| POST | `/admin/nft-jobs/:id/retry` | 운영자 수동 재시도: `FAILED` 잡만 → `PENDING`, `retry_count = 0`, `scheduled_at = now()`, `started_at`/`processed_at` NULL(`last_error`는 원인 확인용으로 유지). nft는 `FAILED`에서 `minted_at`이 있으면 `MINTED`(attach 실패 — 재민팅하지 않음), 없으면 `PENDING`. 감사 `NFT_JOB_RETRIED`(entity `nft_job`)를 같은 트랜잭션에 → `{ id, nft_id, status: 'PENDING', retry_count: 0 }`. FAILED가 아니거나 없으면 **404 `NFT_JOB_NOT_FOUND_OR_NOT_FAILED`** |
| GET | `/admin/audit-logs?entityType=&entityId=&page=` | 감사 로그 → `{ items, page, pageSize: 30, total }` (최신순). `page`≥1 정수, `entityType`≤64자, `entityId` UUID — 그 외 `400`. (이전엔 배열을 반환했으나 FE 호출처가 없어 공통 페이지네이션 봉투로 변경) |

운영자 지정(`is_admin`)은 API가 없다 — `scripts/grant-admin.js`로만 바꾼다([runbook.md](runbook.md) §3). 그 감사 행은 `actor_user_id`가 `null`이고 `action`이 `ADMIN_GRANTED`/`ADMIN_REVOKED`(entity `user`)이며, `scripts/requeue-nft-jobs.js`는 `NFT_JOB_REQUEUED`(entity `nft_job`)를, runbook §7.4의 수동 SQL은 `PAYOUT_CORRECTED_MANUAL`/`PAYOUT_CANCELLED_MANUAL`(entity `payout`)을 남긴다 — 감사 로그 화면은 actor가 비어 있고 action이 위 다섯 가지 중 하나인 행을 "운영 스크립트"로 표시하면 된다. actor가 비어 있다는 것만으로는 구분하지 말 것 — 에이전트의 `APPLICATION_REAPPLIED`처럼 `AuditService.record`가 `actor_agent_id`를 채우지 않아 actor가 비는 행이 이미 있다.

`AdminGuard`는 JWT의 `isAdmin` 클레임 외에 요청마다 `"user"` 행(`is_admin`, `status='ACTIVE'`, 미삭제)을 다시 확인한다 — 어드민 해제/정지가 토큰 만료 전에 즉시 반영된다 (403 `ADMIN_ONLY`).

`GET /media/:id`는 인증 없이 업로드 원본을 immutable cache header와 함께 반환한다. 파일 MIME과
signature는 업로드 시 검증되며 DB의 `media_asset`이 원본 데이터와 URL의 소스 오브 트루스다.

USDC 보상은 Injective EVM native USDC(MTS)로 저장한다. API 요청의 심볼이 `USDC`이면 서버가
`INJECTIVE_EVM_CHAIN_ID`와 `USDC_EVM_CONTRACT_ADDRESS`를 소스 오브 트루스로 사용해
`tokenType=ERC20`, `tokenContractAddress`, `evmChainId`, 그리고 Cosmos 호환
`tokenDenom=erc20:<lowercase address>`를 기록한다. 금액은 6자리 최소 단위 정수다.

## 미구현(스텁) 현황

없음 — 전 엔드포인트 구현 완료.

## NFT 컨트랙트 (경로 A — 표준 cw721-base)

부모-자식 관계는 DB(`nft.parent_nft_id`)가 소스 오브 트루스, 온체인은 표준 CW-721 mint만 수행.
2팀 Nestable 컨트랙트 전환 시 `src/nfts/injective-nft.client.ts`와 워커의 ATTACH 분기만 교체하면 된다.

- Injective **testnet** code_id `39785` (cw721-base v0.18.0)
- 컨트랙트: `inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w` (`.env NFT_CONTRACT_ADDRESS`)
- minter/admin: 마스터 지갑 `inj1fku0cc2tgmsf9uflhvx0e340urktq7vtlcg9hq` (민팅 전용)
- token_id = `nft.id` (UUID) / metadata_uri는 추후 메타데이터 서비스 연결 시 채움
- payout을 PAID로 기록하는 트랜잭션에서 완료 자식 NFT와 mint job도 멱등 생성한다. 자식은 부모 NFT가 `MINTED`/`ATTACHED`일 때만 attach 잡이 걸리고, 부모가 아직 민팅 전이면 `MINTED`로 대기하다가 부모 민팅 완료 시 일괄로 attach 잡이 들어간다 (`nft-job.worker.ts`).
- mainnet은 CosmWasm 업로드가 거버넌스 승인제 — 런칭 일정에 반영 필요

## Admin bounty operations

- `GET /admin/bounties/:id/operations` (AdminGuard): returns `{ bounty, lifecycle, applications, submissions, rewards, payouts, policy }`. Rows include IDs and raw status codes. Reward and payout amounts are **integer strings in minimum token units** (INJ 18 / USDC 6 decimals — the FE converts with `lib/api/codecs.ts`). These fields are admin-only.
  - `bounty`: `id, title, status, submission_deadline, application_deadline, max_winners, application_required, submission_mode`.
  - `lifecycle`: `blockers` (English sentences keyed by target status — the same strings the transition's 400 body carries), `blockerDetails` (same lists as `{ code, count? }`; codes `DEADLINE_PASSED`, `REWARDS_UNFUNDED`, `PENDING_APPLICATIONS`, `UNSUBMITTED_PARTICIPANTS`, `UNRESOLVED_SUBMISSIONS`, `UNPAID_WINNERS` — the FE localizes these), `allowedTransitions` (operator transitions from the current status per `bounty-status.ts`).
  - `applications[]`: `id, status, message, portfolio_url, review_note, applied_at, reviewed_at, actor_name, actor_kind (USER|AGENT), user_id (applicant, or the agent's owner), nickname, agent_id, agent_name`.
  - `submissions[]`: `id, status, submission_url, description, repository_url, commit_sha, current_revision_no, submitted_at, last_resubmitted_at, reviewed_at, actor_name, actor_kind, user_id, nickname, agent_id, agent_name, recipient_wallet_address` (the owner's active primary wallet — `null` means `POST /admin/payouts` will answer 404 `APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND`), `review_comment`, `revisions[]` (newest first; `revisions[0]` is the latest revision, send `current_revision_no` as `revisionNo` when reviewing), `reviews[]`.
  - `rewards[]`: `id, status, token_type, display_symbol, amount, deposited_amount, deposited_at, custody_address, deposit_tx_hash, token_contract_address, evm_chain_id, cap` (= `LEAST(amount, deposited_amount)`, the payout allocation cap), `allocated_amount` (sum of non-cancelled payouts).
  - `payouts[]`: `id, bounty_reward_id, submission_id, status, amount, payout_tx_hash, recipient_address, display_symbol, requested_by, requested_by_nickname, requested_at, approved_by, approved_by_nickname, approved_at, paid_at, requested_by_me` (true when the viewing admin requested it — under the two-person rule they will get 403 `PAYOUT_SELF_APPROVAL`).
  - `policy`: `{ payoutSelfApprovalAllowed }` — `PAYOUT_ALLOW_SELF_APPROVAL=true` on this deployment.
- `POST /admin/submissions/:id/review` additionally accepts optional positive integer `revisionNo`. A mismatch returns `SUBMISSION_REVISION_CHANGED`. Finalized submissions cannot be reviewed again; submissions waiting for revisions may only be rejected with feedback. `REQUEST_REVISION` requires nonblank `comment`.
- Opening a bounty with an unconfirmed reward returns `REWARD_NOT_FUNDED`. Deposit confirmation requires a positive integer amount covering the reward.
- Payout requests require a funded reward (`FUNDED`, `PARTIALLY_PAID`, or `PAID` with headroom left — e.g. after `maxWinners` was raised past the first payout) and an approved submission from that same bounty with a primary linked wallet. Allocations are serialized by locking the reward; pending and paid allocations cannot exceed `LEAST(posted reward amount, confirmed deposit)` — an over-deposit does not raise the cap (`PAYOUT_EXCEEDS_AVAILABLE_REWARD`). Duplicate submission/reward pairs return `PAYOUT_ALREADY_REQUESTED`. The reward status is recomputed after every request and every paid payout: `PAID` only when no payout is still open and the pool or the winner count is exhausted, otherwise `PARTIALLY_PAID` (a `PAID` reward drops back to `PARTIALLY_PAID` when a new payout is requested); nothing changes before the first paid payout.
- Requested revisions can be resubmitted in `OPEN`, `SUBMISSION_CLOSED` or `IN_REVIEW`, including after the deadline. Other new/updated submissions require open intake (and the existing deadline rules).
- `GET /submissions/me` now includes bounty `category`, submission `description`, and latest `review_comment` for participant feedback.

The frontend operations page records **manual multisig** deposits, approvals and completed payments using the existing admin POST endpoints. It does not broadcast transactions.


### Bounty lifecycle and review safeguards

- Operations now returns `bounty.submission_deadline`, `bounty.application_deadline`, `lifecycle.blockers` keyed by target status, and submission `revisions`/`reviews` arrays. Blockers are advisory snapshots; transition checks run again under a bounty row lock.
- OPEN requires funded rewards and a future submission deadline. SUBMISSION_CLOSED/IN_REVIEW can reopen to OPEN, preserving first-open/review timestamps.
- Closing requires resolving pending applications. Before the deadline it also requires every approved participant to have submitted; after the deadline missed submissions do not prevent closing.
- Application creation checks both deadlines; approval requires OPEN and an unexpired submission deadline. Legacy pending applications can be rejected after closing.
- COMPLETED requires no pending applications, no unresolved submissions (including revision requests), every approved winner in a rewarded bounty to have a recorded PAID payout, and no unpaid payout records. No-reward bounties skip the payment requirement.
- `APPROVE` is capped at the bounty's `max_winners`; a further approval returns `MAX_WINNERS_REACHED`.
- Completed/cancelled bounties cannot accept application/submission reviews or new payout requests. A requested revision can be rejected with feedback if it will not be delivered.
- `/applications/me` includes `review_note`; `/submissions/me` includes `payment_status` NONE/PENDING/PAID. Approval of work alone is not payment or bounty completion.
