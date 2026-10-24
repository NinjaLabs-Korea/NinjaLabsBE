# 미결정 사항 — MVP 디폴트 제안

> 기획 문서의 "정해야 할 것" 목록에 대해 백엔드가 제안하는 MVP 디폴트.
> **팀이 뒤집으면 그때 수정한다** — 결정을 기다리며 개발을 멈추지 않기 위한 문서.
> 각 항목: 제안 디폴트 / 근거 / 바꾸려면 어디를 고치는지.

## 바운티

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 한 바운티의 최대 수상자 수 | `bounty.max_winners` 필드로 바운티별 설정 (기본 1) | 스키마 이미 반영. 등록 폼에서 지정 |
| 한 사용자가 여러 제출물을 낼 수 있는지 | **불가 — 1인 1제출 + 리비전** | `UNIQUE(bounty_id, submitter_user_id)` 반영됨. 복수 제출 허용 시 이 인덱스 제거 필요 |
| 마감 후 수정 요청 기한 | 운영자가 REVISION_REQUESTED 부여한 경우만, 별도 기한 없음 | 기한 필요 시 `platform_setting`에 `submission.revision_deadline_days` 추가 |
| 관리자 vs 스폰서 최종 승인 | **관리자(운영자)가 최종 승인** | MVP는 어드민만 심사 UI 보유. 스폰서 계정 기능은 추후 |
| **[결정 2026-10-24] 철회 후 재지원** | **허용 — 같은 행을 다시 연다.** 본인(또는 내 에이전트)의 WITHDRAWN 지원에 `POST /bounties/:id/applications`(에이전트는 `/agent-api/v1/...`)를 다시 보내면 `id`를 유지한 채 PENDING으로 되돌리고 새 `message`/`portfolio_url`, `applied_at = now()`, 심사 필드 초기화, 감사 `APPLICATION_REAPPLIED`. 새 지원과 같은 검사(바운티 OPEN, 지원/제출 마감 전, 제출 방식)를 바운티 행 잠금 아래에서 통과해야 한다. PENDING/APPROVED/REJECTED는 계속 409 `ALREADY_APPLIED` | `uq_application_user`/`uq_application_agent`(0004)는 그대로 — 행을 지우지 않으므로 지원 이력 id가 안정적이다. `applications/applications.service.ts` applyForActor |
| 바운티 취소 조건 | DRAFT/FUNDING_PENDING/OPEN에서만, 관리자만 | `bounties/bounty-status.ts`의 전이 맵에 반영됨 |
| **[결정 2026-10-24] 바운티 삭제 정책** | **돈이 묶여 있으면 409 `BOUNTY_HAS_OPEN_FUNDS`.** 막는 경우: 보상이 `REFUND_PENDING`, 또는 `FUNDED`/`PARTIALLY_PAID`/`PAID`인데 PAID 합계 < `LEAST(amount, deposited_amount)`(남은 돈), 또는 종료 상태(`PAID`/`CANCELLED`/`FAILED`)가 아닌 payout. 허용: 보상이 `DEPOSIT_PENDING`/`REFUNDED`/`CANCELLED`이거나 전액 지급된 `PAID`뿐. 돈이 남은 바운티는 CANCELLED → 환불(REFUNDED) 뒤 삭제 | 검사는 바운티 행 `FOR UPDATE` 아래 — `requestPayout`·`confirmDeposit`도 바운티 행을 먼저 잠그므로 직렬화되고, 삭제된 바운티의 입금 확인은 404 `REWARD_NOT_FOUND_OR_NOT_PENDING`. `bounty-admin.service.ts` remove(). |

## 보상

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 멀티시그 서명 인원/기준 | **2-of-3** (운영 코어 3인) | 오프체인 정책 — 코드 아님. 운영 문서에 서명자 명시 필요 |
| 보상금 일부 지급 | 가능 — `payout.amount`가 reward 총액과 독립 | 분할 지급 = payout 여러 건 |
| **[결정 2026-10-24] 배정 상한** | 취소 아닌 payout 합계 + 새 금액 ≤ **`LEAST(게시 금액 amount, 입금액 deposited_amount)`** — 초과 입금은 상한을 올리지 않는다 (초과분은 환불 대상). 넘으면 400 `PAYOUT_EXCEEDS_AVAILABLE_REWARD`(기존 코드 유지 — FE 호환). 보상 상태 재계산(PAID 판정의 "풀 소진")도 같은 상한을 쓴다 | `rewards.service.ts` requestPayout / advanceRewardStatus |
| **[결정 2026-10-24] payout 승인 2인 규칙** | `POST /admin/payouts/:id/approve`는 요청한 운영자(`payout.requested_by`)와 **다른** 운영자만 — 같으면 403 `PAYOUT_SELF_APPROVAL`. 운영자 1인 배포용 탈출구: env `PAYOUT_ALLOW_SELF_APPROVAL=true`(기본 false) → 허용 + `Logger.warn` + 감사 `PAYOUT_SELF_APPROVED`(PAYOUT_APPROVED 대신) | `requested_by`/`approved_by`는 0006부터 있다(`requested_by NOT NULL`) — 새 마이그레이션 불필요. `rewards/payout-approval.ts`, `rewards.service.ts` markApproved |
| 여러 수상자 분배 | 운영자가 payout 생성 시 금액 직접 입력 | 자동 균등분배는 추후. `bounty_reward` 1:N `payout` 구조라 유연 |
| 취소 시 환불 | 운영자가 멀티시그에서 스폰서 주소로 수동 환불, `bounty_reward.status = REFUNDED` 기록 | REFUND_PENDING → REFUNDED 상태 이미 존재 |
| Injective native USDC 식별 | EVM은 ERC-20 주소+chain ID, Cosmos는 `erc20:<lowercase address>` denom을 함께 저장 | MTS의 동일 자산을 두 실행 환경에서 혼동하지 않도록 서버 환경설정으로 강제 |
| 송금 수수료 부담 | **플랫폼 부담** | Injective 가스비 ~$0.0003, 논의 가치 없는 수준 |

## NFT

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 부모 NFT 없는 유저에게 완료 NFT 발급? | **발급하되 attach 보류** — parent_nft_id NULL 허용. 부모가 있지만 아직 PENDING/MINTING이면 자식은 MINTED로 대기하고, 부모 민팅(MINT_PARENT)이 끝날 때 그 부모에 연결된 MINTED 자식 전부에 ATTACH_CHILD를 멱등 키로 넣는다. 부모 미준비 상태에서 집힌 ATTACH_CHILD는 실패시키지 않고 1시간 뒤로 미룬다 (`nft-job.worker.ts`, test-db `nft-worker.db-spec`) | 보상은 받았는데 증명이 없는 상황 방지 |
| 부모 민팅 실패 자동 재시도 | **총 5회 시도 (첫 시도 + 재시도 4회)**, 10분 간격. 5번째 실패에서 FAILED + 운영자 수동 재시도 (2026-10-24: `POST /admin/nft-jobs/:id/retry` — 같은 잡 행을 PENDING/retry_count 0으로 되살린다. 새 잡을 만들지 않는 이유: 멱등 키가 이미 그 행을 가리킨다. 이미 민팅된 nft(`minted_at` 있음)는 MINTED로 되돌려 attach만 다시 돈다. FE `/admin/nft-jobs`) | `nft-job.worker.ts` MAX_RETRY=5 (`retry_count + 1 >= MAX_RETRY`) — test-db `nft-worker.db-spec`가 4번째/5번째 경계를 검증 |
| 완료 NFT 메타데이터 공개 범위 | 바운티명/완료일/스폰서명 공개, **보상액은 비공개** | 연봉 공개와 같은 민감성. 팀 논의 필요 표시 |
| attach 실패 시 표시 상태 | `MINTED` (민팅됨, 연결 대기중) — FE에 "포트폴리오 연결 중" 표기 권장 | status 체계에 이미 반영 |

## 사용자

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 탈퇴 시 NFT/에이전트 처리 | user soft delete + agent `REVOKED` + API key `REVOKED`. NFT는 온체인이라 회수 불가 — DB 기록만 유지 | 탈퇴 트랜잭션 하나로 처리 |
| 동일 구글 계정 재가입 | **허용** — 단 이전 활동과 연결되지 않는 새 계정 | `UNIQUE(google_id)`가 soft-deleted 행과 충돌 → 탈퇴 시 google_id에 `deleted:{ts}:` 프리픽스 부여 필요 (구현 시 주의) |
| 멤버 해제 시 멤버 정보 | member_role/display_order NULL 처리, bio·링크는 유지 | `members/member-admin.service.ts` setMember 반영됨 |
| 지갑 교체 | MVP **불허** (연결 해제 후 재연결만 운영자 문의) | NFT가 지갑에 귀속되므로 교체는 NFT 이전 문제를 수반 — Phase 3 논의 |

## 에이전트

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 유저 탈퇴 시 에이전트 | 즉시 비활성화 (REVOKED) | 위 탈퇴 처리에 포함 |
| API key 만료 | **90일** (`expires_at`), 만료 30일 전 재발급 안내 | 갱신 정책은 agent-api 문서에 |
| 에이전트별 요청 제한 | 60 req/min (rate limit 미들웨어, Phase 3) | 초기엔 넉넉히, 어뷰징 보이면 축소 |
| 에이전트가 지원+제출 모두 가능? | **가능** — 지원/제출 테이블 모두 agent_id 지원 | 스키마 이미 반영 |

## 스택 관련 (기획 문서와 다른 점)

| 항목 | 결정 | 비고 |
|---|---|---|
| DB | Supabase PostgreSQL | ERD의 PostgreSQL 그대로, 호스팅만 Supabase |
| 서버 호스팅 | NestJS — Vercel 부적합 → **Railway/Fly.io 등 검토 필요** | Vercel은 FE 전용으로 유지 |
| 마스터 지갑 키 | 기획서는 AWS KMS. MVP는 호스팅 플랫폼 secret + 별도 논의 | 민팅 권한만 있어 탈취 시 자금 피해 없음 (기획 확정 사항) |
| ORM | 미사용 — raw SQL (pg) | ERD와 1:1 대응 유지. 팀 합의 시 Kysely/Prisma 전환 가능 |
| Turnstile / rate limit | Phase 1 구현 항목 | 가입 어뷰징 방어 1차선 (기획 확정) |
