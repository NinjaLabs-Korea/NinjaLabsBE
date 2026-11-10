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
| **[결정 2026-10-24] 철회 후 재지원** | **허용 - 같은 행을 다시 연다.** 본인의 WITHDRAWN 지원에 `POST /bounties/:id/applications`를 다시 보내면 `id`를 유지한 채 PENDING으로 되돌리고 새 `message`/`portfolio_url`, `applied_at = now()`, 심사 필드 초기화, 감사 `APPLICATION_REAPPLIED`. 새 지원과 같은 검사(바운티 OPEN, 지원/제출 마감 전)를 바운티 행 잠금 아래에서 통과해야 한다. PENDING/APPROVED/REJECTED는 계속 409 `ALREADY_APPLIED` | `uq_application_user`(0004, 에이전트 인덱스는 에이전트 제거 뒤 쓰지 않는다)는 그대로 - 행을 지우지 않으므로 지원 이력 id가 안정적이다. `applications/applications.service.ts` apply |
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
| **[결정 2026-11-10] 주소 기반 지급 (구글 로그인 전용 전환 1단계)** | 지갑 연결(서명) 대신 **승인된 제출의 제출자가 지급 주소를 직접 입력**한다(`PUT /submissions/:id/payout-address`). `0x`(EVM 20바이트, 대소문자 혼합이면 EIP-55 강제)와 `inj1`(bech32 20바이트 계정, 전부 대문자는 접고 혼합은 거부) 둘 다 받고 **소문자 inj1로 저장**, API는 0x 표기도 함께 낸다(송금 경로가 bank send inj1, ERC20 USDC 0x, CW20 inj1). 32바이트 컨트랙트 주소, 0 주소, 다른 hrp 거부(400 `INVALID_INJECTIVE_ADDRESS`). 서명 검증은 하지 않는다(형식만). 변경은 `APPROVED` + 미삭제 바운티 + 그 제출의 payout 행 0개일 때만, 행이 생기면 409 `PAYOUT_ADDRESS_LOCKED`이고 정정은 runbook §7.4 수동 SQL. `requestPayout`은 제출 행을 `FOR UPDATE`로 잠근 뒤 주소를 `payout.recipient_address`로 **스냅샷**(새 payout은 `recipient_wallet_id` NULL), 주소가 없으면 409 `PAYOUT_ADDRESS_NOT_SET`, 비승인·다른 바운티·탈퇴 제출자는 404 `APPROVED_SUBMISSION_NOT_FOUND`(`APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND` 폐기). `markPaid`는 완료 NFT를 더 만들지 않는다. 감사 `PAYOUT_ADDRESS_SET`과 `PAYOUT_REQUESTED`에는 마스킹된 주소만. 운영 화면은 승인된 미탈퇴 수상자의 `email`을 보여 준다(연락용). 탈퇴하면 본인 제출의 `payout_address`는 지우고 payout 스냅샷은 원장이라 남긴다. 에이전트 제출은 `submitter_user_id`가 없어 이 API로 주소를 넣을 수 없다(에이전트는 PR4에서 제거 예정) | migration 0029(추가·완화만: 컬럼 2+1개, CHECK, `recipient_wallet_id` NULL 허용, 0026 트리거는 지갑 없는 payout 통과). `common/validation/injective-address.ts`, `submissions.service.ts` setPayoutAddress, `rewards.service.ts`, test-db `payout-address.db-spec`. 첫 주소 기반 payout이 생긴 뒤에는 이 변경을 롤백하지 않는다(옛 `markPaid` NFT enqueue와 옛 운영 쿼리 inner join이 그 행을 다루지 못한다). 지갑·NFT·에이전트 제거는 후속 PR |
| 송금 수수료 부담 | **플랫폼 부담** | Injective 가스비 ~$0.0003, 논의 가치 없는 수준 |

## NFT

**[폐기 2026-11-11]** 구글 로그인 전용 전환(BE PR3)으로 NFT 기능을 전부 제거했다. 이 절의 옛 정책(부모 NFT 없는 유저의 완료 NFT 발급과 attach 보류, 부모 민팅 5회 재시도와 운영자 수동 재시도 두 경로, 완료 NFT 메타데이터 공개 범위, attach 실패 시 표시 상태)은 더 적용되지 않는다. 결정과 남긴 것은 위 표의 "[결정 2026-11-11] NFT 제거" 행에 있다.

## 사용자

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 탈퇴 시 NFT/에이전트 처리 | user soft delete. (옛 결정인 agent/API key `REVOKED`는 2026-11-11 에이전트 제거로 없어졌고 레거시 에이전트 행은 건드리지 않는다.) NFT는 온체인이라 회수 불가 - DB 기록만 유지(NFT 모듈은 2026-11-11 제거, 행만 이력으로 남는다) | 탈퇴 트랜잭션 하나로 처리 - **[구현 2026-10-24]** `DELETE /users/me` `{confirmNickname}`, `users/account-withdrawal.service.ts` |
| **[결정 2026-10-24] 탈퇴 차단 / 남기는 것** | 종료 상태(`PAID`/`CANCELLED`/`FAILED`)가 아닌 payout(본인·내 에이전트 제출. **[변경 2026-11-10]** "내 지갑 수령" 조건은 지웠다: 레거시 지갑 payout도 제출자/에이전트 소유자의 지갑으로만 만들어졌으므로 제출 조건이 덮는다)이 있으면 409 `WITHDRAWAL_BLOCKED_OPEN_PAYOUTS`. 통과하면 PENDING 지원과 심사 전 제출(`SUBMITTED`/`RESUBMITTED`/`IN_REVIEW`/`REVISION_REQUESTED` - 남기면 운영자가 승인해 지급 불가능한 제출이 `max_winners` 자리를 차지하거나 미결 제출로 바운티 완료를 막는다)은 `WITHDRAWN`, 승인된 지원·승인/반려된 제출·payout·NFT·감사 기록은 그대로 두고 표시 이름만 `withdrawn_<id 8hex>`로 익명화(bio·링크·태그·멤버 플래그 제거; 활성 유저는 `withdrawn_` 접두사 닉네임을 쓸 수 없다 - 사칭 방지), 지갑은 연결 해제(같은 주소로 새 계정 연결 가능, **[변경 2026-11-10]** 지갑 API 제거 뒤로는 레거시 wallet 행을 건드리지 않는다). ~~아직 payout이 요청되지 않은 승인 제출의 보상은 탈퇴와 함께 포기~~ → **[변경 2026-10-24] 받을 수 있는 미요청 보상이 있으면 탈퇴를 막는다** - 409 `WITHDRAWAL_BLOCKED_PENDING_REWARDS`: 본인/내 에이전트의 `APPROVED` 제출, 바운티가 삭제되지 않은 진행 상태, 보상이 `FUNDED`/`PARTIALLY_PAID`/`PAID`이고 배정 상한(`LEAST(amount, deposited_amount)`)에 여유분이 있으며, 그 (보상, 제출)에 payout 행이 하나도 없을 때(= `requestPayout`이 지금 받아 줄 수 있는 경우). 조용한 포기는 사용자가 FE 문구를 놓치면 되돌릴 수 없는 손실이라 차단으로 바꿨다 - 운영자가 지급을 마치면 탈퇴할 수 있다. 종료/삭제된 바운티, 미입금·여유분 없는 보상, CANCELLED/FAILED payout이 있는 제출(중복 검사로 재요청 불가)은 지급될 수 없으므로 막지 않는다(탈퇴가 영구히 막히지 않게). 탈퇴가 먼저 커밋된 뒤의 `requestPayout`은 여전히 404 `APPROVED_SUBMISSION_NOT_FOUND`(2026-11-10 전에는 `APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND`)(수령자 유저 행 `FOR SHARE` 잠금으로 동시 탈퇴와 직렬화) | `users/account-withdrawal.service.ts` `PENDING_REWARD_SQL`, test-db `withdrawal.db-spec`, e2e `withdrawal`. 스키마 변경 없음 (0014 부분 유니크 인덱스가 deleted 행을 무시, 닉네임 인덱스는 0001부터 부분 인덱스) |
| **[구현 2026-10-30] 탈퇴와 참여의 동시성** | 기수 지원·재지원, 바운티 지원·재지원·제출·재제출은 활성 유저(에이전트면 소유자)의 행을 `FOR SHARE`로 잠근다. 탈퇴가 먼저면 409 `PROFILE_REQUIRED`, 참여가 먼저면 탈퇴가 그 기록까지 `WITHDRAWN`으로 정리한다. 지원/제출 행 잠금 전에 유저를 잠가 탈퇴와 순서를 맞춘다 | `bounties/bounty-actor.ts` `assertOnboarded`, test-db `participation-withdrawal-races.db-spec`. API·스키마 변경 없음 |
| 동일 구글 계정 재가입 | **허용** - 단 이전 활동과 연결되지 않는 새 계정 | 0014부터 `uq_user_google_id`/`uq_user_email`은 `deleted_at IS NULL` 부분 인덱스라 충돌하지 않지만, 탈퇴 시 google_id/email에 `deleted:{ms}:` 프리픽스를 붙여 원래 식별자로 다시 찾히지 않게 한다 (구현됨, test-db `withdrawal.db-spec`) |
| 멤버 해제 시 멤버 정보 | member_role/display_order NULL 처리, bio·링크는 유지 | `members/member-admin.service.ts` setMember 반영됨 |
| 지갑 교체 | **[폐기 2026-11-10]** 지갑 연결·교체 API를 지갑 모듈과 함께 제거했다(BE PR2, 아래 "지갑 제거"). 이하는 2026-11-02~11-10 동안의 정책 기록: **대표 수령 지갑에 한해 허용** (2026-11-02, 이전 MVP 불허 정책 대체). 기존·새 지갑 이중 서명, 미정산 payout(`FAILED` 포함)·미완료 NFT/잡이 있으면 거부 | `/wallets/replacement/challenge`·`verify`, 0024. 기존 지갑 행/NFT/지급 이력 보존, 부모 NFT 재발급/이전 없음. 이후 보상금은 새 대표 지갑, 완료 NFT는 기존 부모 지갑에 발급. 지급 요청·탈퇴·에이전트 등록과 유저 잠금 직렬화. 분실 복구·관리자 강제 교체는 별도 정책 필요. FE 연동 계약은 [api-contract.md](api-contract.md) "대표 수령 지갑 교체" |
| **[결정 2026-11-10] 지갑 제거 (구글 로그인 전용 전환 2단계, BE PR2)** | 사람 계정의 지갑 연결·조회·교체 API(`/wallets/*` 5개)와 `src/wallets/`를 지웠다. 가입은 구글 로그인 -> 프로필 -> 완료이고 새 유저 행은 `onboarding_step` 3(`ONBOARDING_STEP.PROFILE`)으로 시작한다. 2는 `LEGACY_WALLET`으로 이름만 남기고 DB 값은 바꾸지 않는다(FE가 4 미만을 프로필로 보낸다). `/auth/me`와 쿠키 모드 refresh/exchange의 `user`는 옛 FE를 위해 `wallet: null` 키를 계속 보낸다(정리 PR에서 제거). `/admin/users`의 `wallet_address`는 어드민 전용이라 바로 지웠다. 탈퇴는 wallet 행을 건드리지 않고 열린 payout 차단은 제출(제출자·소유 에이전트)로만 판단한다. 감사 `WALLET_REPLACED`는 `LEGACY_AUDIT_ACTIONS`로 옮겨 라벨만 남긴다. `wallet`·challenge 테이블과 행, 운영 화면의 레거시 payout `LEFT JOIN wallet`은 이력 때문에 남긴다 | FE 릴리스 B(가입 3단계) 뒤에 배포. 에러 코드 11개 폐기(`CHALLENGE_*`, `WALLET_LINKED_TO_OTHER_ACCOUNT`, `ACCOUNT_ALREADY_HAS_WALLET`, `WALLET_CHANGE_*` 7개). NFT(부모 민팅 잡을 만들던 유일한 경로가 지갑 verify였다)와 에이전트는 후속 PR |
| **[결정 2026-11-11] NFT 제거 (구글 로그인 전용 전환 3단계, BE PR3)** | `src/nfts/`(민팅 워커, `InjectiveNftClient`, `NftsService`, 잡 콘솔 `GET /admin/nft-jobs`, `POST /admin/nft-jobs/:id/retry`)와 `scripts/requeue-nft-jobs.js`를 지웠다. `NftsModule`을 `app.module.ts`에서 뺐고 종료 순서의 NFT 워커 드레인과 그 e2e(`shutdown.e2e-spec.ts`)도 없앴다. 옛 FE 호환 shim은 키만 남긴다: `/auth/me`와 쿠키 모드 refresh/exchange `user`의 `nft: null`, `GET /users/:nickname`의 `nfts: []`, `GET /hall-of-fame/stats`의 `completionNfts: 0`(각 NFT 쿼리는 제거, BE PR5에서 키 제거). 감사 `NFT_JOB_RETRIED`, 스크립트 `NFT_JOB_REQUEUED`는 `LEGACY_AUDIT_ACTIONS`로 옮겨 라벨만 남긴다. 에러 코드 `NFT_JOB_NOT_FOUND_OR_NOT_FAILED` 폐기. `mainnet-preflight.sql`에서 `nft_job_unfinished`(blocker)와 `nft_contracts`(review), `expected_nft_contract`를 지웠다(남아 있으면 메인넷 전환이 영구 차단된다. review 번호는 4~9로 당겨졌다). `.railway/railway.ts`의 `NFT_CONTRACT_ADDRESS`, `INJECTIVE_NETWORK`, `MASTER_WALLET_MNEMONIC`, `INJECTIVE_GRPC_ENDPOINT`, `NFT_MINTING_ENABLED`는 읽는 코드가 없어졌지만 줄은 지우지 않고 주석만 달았다(운영자가 대시보드 값을 먼저 지운 뒤 PR5에서 줄 제거). `nft`, `nft_job` 테이블과 행, `forfeit-award.js`의 완료 NFT 행 검사는 이력 때문에 남긴다 | 코드가 `nft` 테이블을 쓰지 않으므로 배포 순서 제약 없음(shim이 옛 FE를 덮는다). `@injectivelabs/sdk-ts`는 에이전트(주소 변환, ADR-36 서명)가 아직 써서 PR4에서 함께 뺀다. 에러 코드 카탈로그 103개. 새 NFT를 만들던 경로(지갑 verify, markPaid)는 이미 PR1~2에서 없어졌다 |

## 에이전트 (제거됨)

| 항목 | 결정 | 근거 / 비고 |
|---|---|---|
| **[결정 2026-11-11] 에이전트 제거 (구글 로그인 전용 전환 4단계, BE PR4)** | `src/agents/`(등록·검증·키 회전·폐기, Agent API 인증·가드·키별 throttler, `owned-agents.ts`, `agent-revocation.ts`, `agent-owner-lock.ts`)와 `src/common/crypto/` 전체(EIP-191, ADR-36, 공개키 정규화), `scripts/check-agent-identities.js`, `docs/agent-api.md`를 지우고 `@injectivelabs/sdk-ts`, `@cosmjs/amino`를 의존성에서 뺐다(`ethers`는 유지: 주소 검증). 사람 전용 참여로 줄였다: `BountyActor`는 `assertOnboarded`+`recordAudit`만 남고 `applyAsAgent`/`submitAsAgent`, `ownedAgentIdsSql`, `participantUserIdSql`, 지원·제출·탈퇴·생명주기·완료 수상·공개 프로필·하이라이트·지급 상태의 에이전트 조건을 걷어 `applicant_user_id`/`submitter_user_id`만 본다. `/submissions/me`, `/applications/me`의 `agent: null`, 공개 프로필의 `agents: []`, 운영 화면의 `actor_kind 'USER'`+`agent_id`/`agent_name` null은 옛 FE 호환 shim(BE PR5에서 제거). 바운티 `submissionMode`는 `DIRECT`만(`AGENT`는 400), 생성에서는 선택(기본 `DIRECT`). `ALL /agent-api/v1/*`은 410 `AGENT_API_RETIRED`(`common/http/retired-routes.controller.ts`, PR5에서 제거하면 404). 에러 코드 `INVALID_SIGNATURE`, `INVALID_AGENT_WALLET_ADDRESS`, `AGENT_*`, `MISSING_AGENT_API_KEY`, `INVALID_AGENT_API_KEY`, `AGENT_SUBMISSION_REQUIRED`, `DIRECT_SUBMISSION_REQUIRED` 14개 폐기, 신규 `AGENT_API_RETIRED` 1개(카탈로그 103 -> 90개). 감사 `AGENT_VERIFIED`, `AGENT_KEY_ROTATED`, `AGENT_REVOKED`는 `LEGACY_AUDIT_ACTIONS`로 옮기고 `recordAgentAction`을 지웠다(감사 목록은 과거 행의 `actor_agent_*`를 계속 읽는다). `agent`, `agent_api_key`, `agent_identity_reservation` 테이블과 행, `agent_id` 컬럼은 이력으로 남긴다. 옛 `submission_mode = 'AGENT'` 바운티는 사람이 지원·제출할 수 있다(모드를 더 검사하지 않는다) | **배포 전 읽기 전용 점검**(runbook "BE PR4 배포 전 점검"): `agent_id`가 있는 제출·지원 수, 열린 지갑 기반 payout 수. 에이전트 소유 옛 행은 사람 기준 조회에서 빠지고 승인·지급을 새 코드로 끝낼 수 없으므로 0건이어야 한다. FE-3(에이전트 화면 제거)이 FE `main`에 나간 뒤 바로 배포. 마이그레이션 변경 없음 |

## 운영

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| **[결정 2026-10-24] 운영 알림 채널** | Discord/Slack 호환 incoming webhook 하나 (`OPS_ALERT_WEBHOOK_URL`, 본문 `{content, text}` - 두 서비스 모두 모르는 키를 무시). 미설정이면 로그만 | 새 의존성 없이 global `fetch`. 채널 분리(심각도별)가 필요해지면 `AlertService`에 키 접두사 → URL 맵을 추가 |
| 알림 임계값 | payout 48시간 미승인(5분 주기 검사), 5xx **5분 안 20건 초과**, 기동 실패·preDeploy 마이그레이션 실패 즉시 (NFT 잡 알림은 2026-11-11 NFT 제거로 없어졌다) | 바꾸려면 `payout.worker.ts`, `http-exception.filter.ts` `HTTP_5XX_BURST_*` |
| 중복 억제 | 같은 키 **30분에 1회**, 인스턴스별 in-memory, 억제 건수를 다음 알림에 붙인다. 쿨다운은 웹훅이 **2xx로 받은 뒤에만** 시작한다 - 실패하면 2초 뒤 1회 재시도, 그래도 실패면 쿨다운 없이 끝나 다음 발생이 다시 보낸다(웹훅 일시 장애가 30분 침묵이 되지 않게, 2026-10-24). 같은 키가 전송 중(재시도 대기 포함)이면 겹친 호출은 억제 수로만 센다. 기동 실패는 프로세스가 곧 죽으므로 억제 없음(재시작 루프마다 1통 - Railway restart 상한까지) | `ALERT_COOLDOWN_MS` (`common/alerts/alert.service.ts`) |

## 기수 모집

| 항목 | 결정 | 근거 / 비고 |
|---|---|---|
| **[결정 2026-10-31] 지원서 질문은 기수마다 편집** | 고정: `displayName`, `telegram`, `twitter`, `intro`(컬럼, 항상 필수). 나머지는 `cohort.questions`(JSONB, 0021)를 운영자가 `PUT /admin/cohorts/:id/questions`로 통째로 편집. 기본 질문은 Web3 경력 + 참여하고 싶은 분야(기타 상세)이고 "현재 활동 유형"은 폐기(소속은 intro에) | 고정 필드는 검색(`q`), 핸들 정규화/CHECK, 심사 화면이 의존한다. 답변은 쓰는 순간 질문 라벨을 복사한 **스냅샷**이라 질문을 고쳐도 낸 지원서는 안 바뀐다. 옛 행은 읽을 때 합성(`legacyAnswers`), 쓰기 모양은 `chk_cohort_application_answer_shape`가 옛/새 형식 중 하나로 강제 |
| 옛 지원서 본문 호환 | **[2026-10-31 요청 본문 경로 제거]** FE 릴리스 #69(질문 폼) 운영 반영 뒤 DTO의 옛 필드, `legacyOfInput`, `normalizeOtherDetails`, 옛 PATCH 분기를 지웠다. 옛 본문은 400 DTO 검증 실패(forbidNonWhitelisted). 옛 형식 행의 읽기 합성(`legacyAnswers`), 0021 CHECK, 응답의 deprecated 필드, 별칭 필터(`interestArea`, `activityType`)는 남긴다 | 운영 DB에 옛 형식 행이 남아 있어 읽기 쪽은 필요하다. 응답 deprecated 필드와 별칭 필터는 요청 본문이 아니라 이번 범위 밖(운영 FE는 별칭 필터를 쓰지 않는다): 지울지는 따로 정한다 |
| 지갑 충돌 코드 분리 (**[폐기 2026-11-10]** 두 코드 모두 지갑 API와 함께 제거) | `WALLET_LINKED_TO_OTHER_ACCOUNT`(주소가 다른 계정에), `ACCOUNT_ALREADY_HAS_WALLET`(내 대표 지갑이 이미 있음). **[2026-10-31]** 폴백 `WALLET_ALREADY_LINKED`는 없앴다: 두 인덱스 밖의 23505(이름 없는 것 포함)는 그대로 던져 500으로 드러낸다 | 제약 이름(`uq_wallet_chain_address_active` / `uq_wallet_primary_per_user`)으로 구분. 새 코드를 아는 FE가 먼저 배포돼야 한다 |
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
