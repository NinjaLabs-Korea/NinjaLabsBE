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
| 바운티 취소 조건 | DRAFT/FUNDING_PENDING/OPEN에서만, 관리자만 | `admin.service.ts`의 전이 맵에 반영됨 |

## 보상

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 멀티시그 서명 인원/기준 | **2-of-3** (운영 코어 3인) | 오프체인 정책 — 코드 아님. 운영 문서에 서명자 명시 필요 |
| 보상금 일부 지급 | 가능 — `payout.amount`가 reward 총액과 독립 | 분할 지급 = payout 여러 건 |
| 여러 수상자 분배 | 운영자가 payout 생성 시 금액 직접 입력 | 자동 균등분배는 추후. `bounty_reward` 1:N `payout` 구조라 유연 |
| 취소 시 환불 | 운영자가 멀티시그에서 스폰서 주소로 수동 환불, `bounty_reward.status = REFUNDED` 기록 | REFUND_PENDING → REFUNDED 상태 이미 존재 |
| 송금 수수료 부담 | **플랫폼 부담** | Injective 가스비 ~$0.0003, 논의 가치 없는 수준 |

## NFT

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 부모 NFT 없는 유저에게 완료 NFT 발급? | **발급하되 attach 보류** — parent_nft_id NULL 허용, 부모 민팅 후 ATTACH_CHILD 잡 | 보상은 받았는데 증명이 없는 상황 방지 |
| 부모 민팅 실패 자동 재시도 | **5회** (10분 간격), 이후 FAILED + 운영자 수동 재시도 | `nft-job.worker.ts` MAX_RETRY=5 |
| 완료 NFT 메타데이터 공개 범위 | 바운티명/완료일/스폰서명 공개, **보상액은 비공개** | 연봉 공개와 같은 민감성. 팀 논의 필요 표시 |
| attach 실패 시 표시 상태 | `MINTED` (민팅됨, 연결 대기중) — FE에 "포트폴리오 연결 중" 표기 권장 | status 체계에 이미 반영 |

## 사용자

| 항목 | MVP 디폴트 | 근거 / 비고 |
|---|---|---|
| 탈퇴 시 NFT/에이전트 처리 | user soft delete + agent `REVOKED` + API key `REVOKED`. NFT는 온체인이라 회수 불가 — DB 기록만 유지 | 탈퇴 트랜잭션 하나로 처리 |
| 동일 구글 계정 재가입 | **허용** — 단 이전 활동과 연결되지 않는 새 계정 | `UNIQUE(google_id)`가 soft-deleted 행과 충돌 → 탈퇴 시 google_id에 `deleted:{ts}:` 프리픽스 부여 필요 (구현 시 주의) |
| 멤버 해제 시 멤버 정보 | member_role/display_order NULL 처리, bio·링크는 유지 | `admin.service.ts` setMember 반영됨 |
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
