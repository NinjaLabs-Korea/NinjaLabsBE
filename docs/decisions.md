# 미결정 사항 - MVP 디폴트 제안

> 기획 문서의 "정해야 할 것" 목록에 대해 백엔드가 제안하는 MVP 디폴트.
> **팀이 뒤집으면 그때 수정한다** - 결정을 기다리며 개발을 멈추지 않기 위한 문서.
> 각 항목: 제안 디폴트 / 근거 / 바꾸려면 어디를 고치는지.

## 바운티

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 한 바운티의 최대 수상자 수 | `bounty.max_winners` 필드로 바운티별 설정 (기본 1) | 스키마 이미 반영. 등록 폼에서 지정 |
| 한 사용자가 여러 제출물을 낼 수 있는지 | **불가 - 1인 1제출 + 리비전** | `UNIQUE(bounty_id, submitter_user_id)` 반영됨. 복수 제출 허용 시 이 인덱스 제거 필요 |
| 마감 후 수정 요청 기한 | 운영자가 REVISION_REQUESTED 부여한 경우만, 별도 기한 없음 | 기한 필요 시 `platform_setting`에 `submission.revision_deadline_days` 추가 |
| 관리자 vs 스폰서 최종 승인 | **관리자(운영자)가 최종 승인** | MVP는 어드민만 심사 UI 보유. 스폰서 계정 기능은 추후 |
| **[결정 2026-10-24] 철회 후 재지원** | **허용 - 같은 행을 다시 연다.** 본인(또는 내 에이전트)의 WITHDRAWN 지원에 `POST /bounties/:id/applications`(에이전트는 `/agent-api/v1/...`)를 다시 보내면 `id`를 유지한 채 PENDING으로 되돌리고 새 `message`/`portfolio_url`, `applied_at = now()`, 심사 필드 초기화, 감사 `APPLICATION_REAPPLIED`. 새 지원과 같은 검사(바운티 OPEN, 지원/제출 마감 전, 제출 방식)를 바운티 행 잠금 아래에서 통과해야 한다. PENDING/APPROVED/REJECTED는 계속 409 `ALREADY_APPLIED` | `uq_application_user`/`uq_application_agent`(0004)는 그대로 - 행을 지우지 않으므로 지원 이력 id가 안정적이다. `applications/applications.service.ts` applyForActor |
| 바운티 취소 조건 | DRAFT/FUNDING_PENDING/OPEN에서만, 관리자만 | `bounties/bounty-status.ts`의 전이 맵에 반영됨 |
| **[결정 2026-10-24] 바운티 삭제 정책** | **돈이 묶여 있으면 409 `BOUNTY_HAS_OPEN_FUNDS`.** 막는 경우: 보상이 `REFUND_PENDING`, 또는 `FUNDED`/`PARTIALLY_PAID`/`PAID`인데 PAID 합계 < `deposited_amount`(남은 돈), 또는 종료 상태(`PAID`/`CANCELLED`/`FAILED`)가 아닌 payout. 허용: 보상이 `DEPOSIT_PENDING`/`REFUNDED`/`CANCELLED`이거나 입금액 전액이 지급된 `PAID`뿐. 돈이 남은 바운티는 CANCELLED → 환불(`scripts/record-refund.js`, REFUNDED) 뒤 삭제. **[개정 2026-10-25]** 비교 기준을 배정 상한 `LEAST(amount, deposited_amount)`에서 **입금액 전체**로 바꿨다 - 상한 기준은 초과 입금분(입금 150 / 게시 100)을 무시해 50이 기록 없이 남은 채 삭제됐다. 같은 날 환불 스크립트도 `PAID` 보상을 받게 했다(입금액 − PAID > 0, 바운티 CANCELLED, 열린 payout 없음은 그대로) - max_winners를 채워 `PAID`로 닫혔지만 상한보다 적게 지급된 보상이 환불도 삭제도 못 하던 막다른 길을 없앤다. 남는 예외: 전액 지급됐지만 초과 입금분이 남은 **COMPLETED** 바운티는 환불 스크립트(CANCELLED만)가 받지 않으므로 삭제 불가(409) - COMPLETED 잔액 환불 경로는 제품 결정 대기(runbook §7.4) | 검사는 바운티 행 `FOR UPDATE` 아래 - `requestPayout`·`confirmDeposit`도 바운티 행을 먼저 잠그므로 직렬화되고, 삭제된 바운티의 입금 확인은 404 `REWARD_NOT_FOUND_OR_NOT_PENDING`. `bounty-admin.service.ts` remove(), 비교식 `rewards/payout-status.ts` `rewardHoldsFundsSql`. 배정 상한(`rewardCapSql`, requestPayout)은 그대로 |

## 보상

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 멀티시그 서명 인원/기준 | **2-of-3** (운영 코어 3인) | 오프체인 정책 - 코드 아님. 운영 문서에 서명자 명시 필요 |
| 보상금 일부 지급 | 가능 - `payout.amount`가 reward 총액과 독립 | 분할 지급 = payout 여러 건 |
| **[결정 2026-10-24] 배정 상한** | 취소 아닌 payout 합계 + 새 금액 ≤ **`LEAST(게시 금액 amount, 입금액 deposited_amount)`** - 초과 입금은 상한을 올리지 않는다 (초과분은 환불 대상). 넘으면 400 `PAYOUT_EXCEEDS_AVAILABLE_REWARD`(기존 코드 유지 - FE 호환). 보상 상태 재계산(PAID 판정의 "풀 소진")도 같은 상한을 쓴다 | `rewards.service.ts` requestPayout / advanceRewardStatus |
| **[결정 2026-10-24] payout 승인 2인 규칙** | `POST /admin/payouts/:id/approve`는 요청한 운영자(`payout.requested_by`)와 **다른** 운영자만 - 같으면 403 `PAYOUT_SELF_APPROVAL`. 운영자 1인 배포용 탈출구: env `PAYOUT_ALLOW_SELF_APPROVAL=true`(기본 false) → 허용 + `Logger.warn` + 감사 `PAYOUT_SELF_APPROVED`(PAYOUT_APPROVED 대신) | `requested_by`/`approved_by`는 0006부터 있다(`requested_by NOT NULL`) - 새 마이그레이션 불필요. `rewards/payout-approval.ts`, `rewards.service.ts` markApproved |
| 여러 수상자 분배 | 운영자가 payout 생성 시 금액 직접 입력 | 자동 균등분배는 추후. `bounty_reward` 1:N `payout` 구조라 유연 |
| 취소 시 환불 | 운영자가 멀티시그에서 스폰서 주소로 수동 환불, `bounty_reward.status = REFUNDED` 기록 | REFUND_PENDING → REFUNDED 상태 이미 존재 |
| **[결정 2026-10-25] 받을 몫이 남은 수상자가 있으면 취소 불가** | 승인됐지만 아직 받을 몫이 남은 수상자(진행 중 payout 또는 `owesUnpaidRewardSql` 미지급 승인 제출)가 있으면 `→ CANCELLED`는 400 `UNPAID_WINNERS`(COMPLETED 차단과 같은 코드·문구). 막는 이유: IN_REVIEW → OPEN(재오픈) → CANCELLED 경로가 열려 있고, 취소 뒤 환불(`scripts/record-refund.js`)은 입금액 − PAID라 못 받은 수상자 몫이 스폰서에게 돌아간다. 모든 수상자 지급 완료 또는 runbook §7.4대로 보상 미지급 처리 후 CANCELLED → 환불이 여전히 환불 경로 | `bounties/admin/bounty-lifecycle.service.ts` blockers(). 전이표·`payout-status.ts`·환불 스크립트는 그대로 |
| Injective native USDC 식별 | EVM은 ERC-20 주소+chain ID, Cosmos는 `erc20:<lowercase address>` denom을 함께 저장 | MTS의 동일 자산을 두 실행 환경에서 혼동하지 않도록 서버 환경설정으로 강제 |
| **[결정 2026-10-24] 지급 총액 공개 지표** | `GET /hall-of-fame/stats`의 `paidTotals`는 **status = `PAID` payout만** 합산, 삭제된 바운티 제외, `(upper(display_symbol), token_type)`별 base unit 문자열. 토큰 decimals는 DB에 없으므로 서버 상수표(`rewards/reward-token-decimals.ts`, INJ 18 / USDC 6)로 붙이고 모르는 심볼은 `null` | 환율 환산(USD 합계)은 하지 않는다 - 가격 소스 의존과 시점 문제. FE `TOKEN_DECIMALS`와 같은 값을 유지할 것 |
| 송금 수수료 부담 | **플랫폼 부담** | Injective 가스비 ~$0.0003, 논의 가치 없는 수준 |

## NFT

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 부모 NFT 없는 유저에게 완료 NFT 발급? | **발급하되 attach 보류** - parent_nft_id NULL 허용. 부모가 있지만 아직 PENDING/MINTING이면 자식은 MINTED로 대기하고, 부모 민팅(MINT_PARENT)이 끝날 때 그 부모에 연결된 MINTED 자식 전부에 ATTACH_CHILD를 멱등 키로 넣는다. 부모 미준비 상태에서 집힌 ATTACH_CHILD는 실패시키지 않고 1시간 뒤로 미룬다 (`nft-job.worker.ts`, test-db `nft-worker.db-spec`) | 보상은 받았는데 증명이 없는 상황 방지 |
| 부모 민팅 실패 자동 재시도 | **총 5회 시도 (첫 시도 + 재시도 4회)**, 10분 간격. 5번째 실패에서 FAILED + 운영자 수동 재시도 - 두 경로, 원인을 고친 뒤 실행: (1) 운영 콘솔 `POST /admin/nft-jobs/:id/retry` (2026-10-24, FE `/admin/nft-jobs`, 감사 `NFT_JOB_RETRIED`) - 같은 잡 행을 PENDING/retry_count 0으로 되살린다. 새 잡을 만들지 않는 이유: 멱등 키가 이미 그 행을 가리킨다. 이미 민팅된 nft(`minted_at` 있음)는 MINTED로 되돌려 attach만 다시 돈다. (2) DB 접속 권한자용 `scripts/requeue-nft-jobs.js <id>…` 또는 `--all`(FAILED → PENDING, `retry_count` 0으로 새 5회, nft FAILED → token_id 있으면 MINTED 없으면 PENDING, 감사 `NFT_JOB_REQUEUED`, [runbook.md](runbook.md) §7.3) | `nft-job.worker.ts` MAX_RETRY=5 (`retry_count + 1 >= MAX_RETRY`) - test-db `nft-worker.db-spec`가 4번째/5번째 경계를 검증 |
| 완료 NFT 메타데이터 공개 범위 | 바운티명/완료일/스폰서명 공개, **보상액은 비공개** | 연봉 공개와 같은 민감성. 팀 논의 필요 표시 |
| attach 실패 시 표시 상태 | `MINTED` (민팅됨, 연결 대기중) - FE에 "포트폴리오 연결 중" 표기 권장 | status 체계에 이미 반영 |

## 사용자

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 탈퇴 시 NFT/에이전트 처리 | user soft delete + agent `REVOKED` + API key `REVOKED`. NFT는 온체인이라 회수 불가 - DB 기록만 유지 | 탈퇴 트랜잭션 하나로 처리 - **[구현 2026-10-24]** `DELETE /users/me` `{confirmNickname}`, `users/account-withdrawal.service.ts` |
| **[결정 2026-10-24] 탈퇴 차단 / 남기는 것** | 종료 상태(`PAID`/`CANCELLED`/`FAILED`)가 아닌 payout(본인·내 에이전트 제출 또는 내 지갑 수령)이 있으면 409 `WITHDRAWAL_BLOCKED_OPEN_PAYOUTS`. 통과하면 PENDING 지원과 심사 전 제출(`SUBMITTED`/`RESUBMITTED`/`IN_REVIEW`/`REVISION_REQUESTED` - 남기면 운영자가 승인해 지급 불가능한 제출이 `max_winners` 자리를 차지하거나 미결 제출로 바운티 완료를 막는다)은 `WITHDRAWN`, 승인된 지원·승인/반려된 제출·payout·NFT·감사 기록은 그대로 두고 표시 이름만 `withdrawn_<id 8hex>`로 익명화(bio·링크·태그·멤버 플래그 제거; 활성 유저는 `withdrawn_` 접두사 닉네임을 쓸 수 없다 - 사칭 방지), 지갑은 연결 해제(같은 주소로 새 계정 연결 가능). ~~아직 payout이 요청되지 않은 승인 제출의 보상은 탈퇴와 함께 포기~~ → **[변경 2026-10-24] 받을 수 있는 미요청 보상이 있으면 탈퇴를 막는다** - 409 `WITHDRAWAL_BLOCKED_PENDING_REWARDS`: 본인/내 에이전트의 `APPROVED` 제출, 바운티가 삭제되지 않은 진행 상태, 보상이 `FUNDED`/`PARTIALLY_PAID`/`PAID`이고 배정 상한(`LEAST(amount, deposited_amount)`)에 여유분이 있으며, 그 (보상, 제출)에 payout 행이 하나도 없을 때(= `requestPayout`이 지금 받아 줄 수 있는 경우). 조용한 포기는 사용자가 FE 문구를 놓치면 되돌릴 수 없는 손실이라 차단으로 바꿨다 - 운영자가 지급을 마치면 탈퇴할 수 있다. 종료/삭제된 바운티, 미입금·여유분 없는 보상, CANCELLED/FAILED payout이 있는 제출(중복 검사로 재요청 불가)은 지급될 수 없으므로 막지 않는다(탈퇴가 영구히 막히지 않게). 탈퇴가 먼저 커밋된 뒤의 `requestPayout`은 여전히 404 `APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND`(수령자 유저 행 `FOR SHARE` 잠금으로 동시 탈퇴와 직렬화) | `users/account-withdrawal.service.ts` `PENDING_REWARD_SQL`, test-db `withdrawal.db-spec`, e2e `withdrawal`. 스키마 변경 없음 (0014 부분 유니크 인덱스가 deleted 행을 무시, 닉네임 인덱스는 0001부터 부분 인덱스) |
| **[구현 2026-10-30] 탈퇴와 참여의 동시성** | 기수 지원·재지원, 바운티 지원·재지원·제출·재제출은 활성 유저(에이전트면 소유자)의 행을 `FOR SHARE`로 잠근다. 탈퇴가 먼저면 409 `PROFILE_REQUIRED`, 참여가 먼저면 탈퇴가 그 기록까지 `WITHDRAWN`으로 정리한다. 지원/제출 행 잠금 전에 유저를 잠가 탈퇴와 순서를 맞춘다 | `bounties/bounty-actor.ts` `assertOnboarded`, test-db `participation-withdrawal-races.db-spec`. API·스키마 변경 없음 |
| 동일 구글 계정 재가입 | **허용** - 단 이전 활동과 연결되지 않는 새 계정 | 0014부터 `uq_user_google_id`/`uq_user_email`은 `deleted_at IS NULL` 부분 인덱스라 충돌하지 않지만, 탈퇴 시 google_id/email에 `deleted:{ms}:` 프리픽스를 붙여 원래 식별자로 다시 찾히지 않게 한다 (구현됨, test-db `withdrawal.db-spec`) |
| 멤버 해제 시 멤버 정보 | member_role/display_order NULL 처리, bio·링크는 유지 | `members/member-admin.service.ts` setMember 반영됨 |
| 지갑 교체 | MVP **불허** (연결 해제 후 재연결만 운영자 문의) | NFT가 지갑에 귀속되므로 교체는 NFT 이전 문제를 수반 - Phase 3 논의 |

## 에이전트

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 유저 탈퇴 시 에이전트 | 즉시 비활성화 (REVOKED) | 위 탈퇴 처리에 포함 |
| API key 만료 | **90일** (`expires_at`), 만료 30일 전 재발급 안내 | 갱신 정책은 agent-api 문서에 |
| 에이전트별 요청 제한 | 60 req/min (rate limit 미들웨어, Phase 3) | 초기엔 넉넉히, 어뷰징 보이면 축소 |
| 에이전트가 지원+제출 모두 가능? | **가능** - 지원/제출 테이블 모두 agent_id 지원 | 스키마 이미 반영 |

## 운영

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| **[결정 2026-10-24] 운영 알림 채널** | Discord/Slack 호환 incoming webhook 하나 (`OPS_ALERT_WEBHOOK_URL`, 본문 `{content, text}` - 두 서비스 모두 모르는 키를 무시). 미설정이면 로그만 | 새 의존성 없이 global `fetch`. 채널 분리(심각도별)가 필요해지면 `AlertService`에 키 접두사 → URL 맵을 추가 |
| 알림 임계값 | payout 48시간 미승인(5분 주기 검사), nft_job FAILED 즉시, 고아 PROCESSING(15분) 재큐잉 즉시, 5xx **5분 안 20건 초과**, 기동 실패·preDeploy 마이그레이션 실패 즉시 | 바꾸려면 `payout.worker.ts`, `nft-job.worker.ts`, `http-exception.filter.ts` `HTTP_5XX_BURST_*` |
| 중복 억제 | 같은 키 **30분에 1회**, 인스턴스별 in-memory, 억제 건수를 다음 알림에 붙인다. 쿨다운은 웹훅이 **2xx로 받은 뒤에만** 시작한다 - 실패하면 2초 뒤 1회 재시도, 그래도 실패면 쿨다운 없이 끝나 다음 발생이 다시 보낸다(웹훅 일시 장애가 30분 침묵이 되지 않게, 2026-10-24). 같은 키가 전송 중(재시도 대기 포함)이면 겹친 호출은 억제 수로만 센다. 기동 실패는 프로세스가 곧 죽으므로 억제 없음(재시작 루프마다 1통 - Railway restart 상한까지) | `ALERT_COOLDOWN_MS` (`common/alerts/alert.service.ts`) |

## 기수 모집

| 항목 | 결정 | 근거 / 비고 |
|---|---|---|
| **[결정 2026-10-31] 지원서 질문은 기수마다 편집** | 고정: `displayName`, `telegram`, `twitter`, `intro`(컬럼, 항상 필수). 나머지는 `cohort.questions`(JSONB, 0021)를 운영자가 `PUT /admin/cohorts/:id/questions`로 통째로 편집. 기본 질문은 Web3 경력 + 참여하고 싶은 분야(기타 상세)이고 "현재 활동 유형"은 폐기(소속은 intro에) | 고정 필드는 검색(`q`), 핸들 정규화/CHECK, 심사 화면이 의존한다. 답변은 쓰는 순간 질문 라벨을 복사한 **스냅샷**이라 질문을 고쳐도 낸 지원서는 안 바뀐다. 옛 행은 읽을 때 합성(`legacyAnswers`), 쓰기 모양은 `chk_cohort_application_answer_shape`가 옛/새 형식 중 하나로 강제 |
| 옛 지원서 본문 호환 | **[2026-10-31 요청 본문 경로 제거]** FE 릴리스 #69(질문 폼) 운영 반영 뒤 DTO의 옛 필드, `legacyOfInput`, `normalizeOtherDetails`, 옛 PATCH 분기를 지웠다. 옛 본문은 400 DTO 검증 실패(forbidNonWhitelisted). 옛 형식 행의 읽기 합성(`legacyAnswers`), 0021 CHECK, 응답의 deprecated 필드, 별칭 필터(`interestArea`, `activityType`)는 남긴다 | 운영 DB에 옛 형식 행이 남아 있어 읽기 쪽은 필요하다. 응답 deprecated 필드와 별칭 필터는 요청 본문이 아니라 이번 범위 밖(운영 FE는 별칭 필터를 쓰지 않는다): 지울지는 따로 정한다 |
| 지갑 충돌 코드 분리 | `WALLET_LINKED_TO_OTHER_ACCOUNT`(주소가 다른 계정에), `ACCOUNT_ALREADY_HAS_WALLET`(내 대표 지갑이 이미 있음). **[2026-10-31]** 폴백 `WALLET_ALREADY_LINKED`는 없앴다: 두 인덱스 밖의 23505(이름 없는 것 포함)는 그대로 던져 500으로 드러낸다 | 제약 이름(`uq_wallet_chain_address_active` / `uq_wallet_primary_per_user`)으로 구분. 새 코드를 아는 FE가 먼저 배포돼야 한다 |
| 보상 미지급 문구 | 사용자/운영자에게 보이는 말은 "보상 미지급"(ko), 내부 식별자(`forfeit*`, `SUBMISSION_AWARD_FORFEITED`, 코멘트 접두사 `forfeited:`)는 그대로 | 옛 표현은 돈·법적 어조가 세서 쓰지 않는다. `CANCELLED` payout은 항상 "지급 취소"로 쓴다 |

## 스택 관련 (기획 문서와 다른 점)

| 항목 | 결정 | 비고 |
|---|---|---|
| DB | Supabase PostgreSQL | ERD의 PostgreSQL 그대로, 호스팅만 Supabase |
| 서버 호스팅 | NestJS - Vercel 부적합 → **Railway/Fly.io 등 검토 필요** | Vercel은 FE 전용으로 유지 |
| 마스터 지갑 키 | 기획서는 AWS KMS. MVP는 호스팅 플랫폼 secret + 별도 논의 | 민팅 권한만 있어 탈취 시 자금 피해 없음 (기획 확정 사항) |
| ORM | 미사용 - raw SQL (pg) | ERD와 1:1 대응 유지. 팀 합의 시 Kysely/Prisma 전환 가능 |
| rate limit 공유 저장소 | **Postgres 테이블**(`throttler_storage`, UNLOGGED, 0016) + 원자적 upsert, `THROTTLER_STORAGE=postgres`가 production 기본. 고정 창, DB 오류 시 fail-open | Redis(`@nestjs/throttler-storage-redis`)는 새 인프라·의존성이 필요하다. 요청당 쿼리 1회는 현재 트래픽에서 감당 가능 - 트래픽이 커지면 Redis 저장소로 교체(인터페이스는 `ThrottlerStorage` 그대로) |
| Turnstile / rate limit | **구현됨** - `/auth/google`에 Turnstile(선택, `TURNSTILE_SECRET_KEY`) + IP 20/min | 가입 어뷰징 방어 1차선 (기획 확정). 첫 로그인인지는 Google 콜백 뒤에 알 수 있어 모든 로그인 시작에 건다. Cloudflare 불통 시 fail-closed(503) - 봇 방지를 조용히 끄지 않는다 |
