# NinjaLabs Backend API 계약 v0.1

> FE 레포의 `docs/auth-api-contract.md`(바인딩 계약)와 맞춰가는 백엔드 측 명세.
> FE 팀 리뷰 후 확정한다. Base URL: `https://api.ninjalabs.xyz` (예정) / 로컬 `http://localhost:4000`

## 공통 규칙

- 인증: `Authorization: Bearer <accessToken>` 헤더. access token은 JWT(15분), refresh token으로 재발급.
- 에러 응답: `{ "statusCode": number, "message": "ERROR_CODE", "error": "..." }` (NestJS 기본 포맷)
- 시간: ISO 8601 (UTC, timestamptz)
- 토큰 금액: 최소 단위 정수 **문자열** (`"1000000000000000000"` = 1 INJ). JS number 정밀도 문제로 문자열 고정.
- 페이지네이션: `?page=1&pageSize=12` → `{ items, page, pageSize, total }`
- 읽기(공개) 엔드포인트는 로그인 불필요 — "행동" 시점에만 인증 요구 (기획 원칙)

## 인증 (Auth)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/auth/google` | - | 구글 동의 화면으로 리다이렉트 |
| GET | `/auth/google/callback` | - | code 교환 → 세션 발급 → FE로 리다이렉트 |
| POST | `/auth/refresh` | - | `{refreshToken}` → `{accessToken}` |
| POST | `/auth/logout` | - | `{refreshToken}` → 204 |
| GET | `/auth/me` | ✅ | 현재 유저 프로필 + 온보딩/지갑 상태 |

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
| POST | `/users/me/profile` | ✅ | `{nickname, bio, tags[]}` 전부 필수 (온보딩 3단계) |
| POST | `/users/me/complete-onboarding` | ✅ | 온보딩 완료 플래그 |
| GET | `/users/:nickname` | - | 공개 프로필: 기본정보 + 완료 바운티 + 에이전트 |

## 지갑 (온보딩 2단계)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/wallets/challenge` | ✅ | `{address}` → `{nonce, message, expiresAt}` (5분 만료, 1회용) |
| POST | `/wallets/verify` | ✅ | Keplr/Leap: `{address, signature, publicKey}` / EVM: `{address, signature}` → 검증 성공 시 지갑 저장 + NFT 민팅 잡 등록 |
| GET | `/wallets/me` | ✅ | 내 대표 지갑 (없으면 null — 미연결 상태) |

- 검증 실패/스킵 → FE는 그대로 온보딩 진행 (지갑은 null). 에러코드: `INVALID_SIGNATURE`, `CHALLENGE_EXPIRED`, `WALLET_ALREADY_LINKED`
- Keplr/Leap: challenge의 `message`를 `signArbitrary(chainId, address, message)`로 서명.
  응답의 `signature`(base64)와 `pub_key.value`(base64)를 그대로 `signature`, `publicKey`로 전송.
  서버는 ADR-36 sign doc을 재구성해 keccak256/secp256k1로 검증하고 공개키→주소 일치도 확인한다.
- MetaMask 등 EVM 지갑: challenge의 `message`를 EIP-191 `personal_sign`으로 서명하고
  0x `address`와 hex `signature`를 전송한다. 서버는 서명자를 복구한 뒤 대응되는 `inj1` 주소로
  정규화해 저장하므로 CW-721 NFT의 수신 주소로도 사용할 수 있다.

## 바운티 (공개 읽기)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/bounties?page=&category=&status=` | - | 목록 (DRAFT/FUNDING_PENDING 비노출) + 보상 요약 |
| GET | `/bounties/:id` | - | 상세 + 보상 + 첨부 |

## 바운티 참여 (행동 — 인증 필요)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/bounties/:id/applications` | ✅ | 지원형 지원 `{message, portfolioUrl?}` — 409 `ALREADY_APPLIED` |
| GET | `/applications/me` | ✅ | 내 지원 내역 (FE `/applications` 페이지) |
| POST | `/applications/:id/withdraw` | ✅ | 지원 철회 (PENDING만) |
| POST | `/bounties/:id/submissions` | ✅ | 제출/재제출 `{submissionUrl, description, repositoryUrl?, commitSha?}` |
| GET | `/submissions/me` | ✅ | 내 제출 내역 |

제출 검증 규칙 (서버가 강제, FE는 안내만):

- 지원형인데 APPROVED 지원서 없음 → 403 `APPLICATION_NOT_APPROVED`
- 마감 후 (REVISION_REQUESTED 아님) → 400 `DEADLINE_PASSED`
- APPROVED/REJECTED 확정 후 → 409 `SUBMISSION_FINALIZED`

## 커뮤니티 (공개 읽기)

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/notices?page=&category=` | - | 공지/소식 목록 |
| GET | `/notices/:id` | - | 상세 (삭제/비공개 → 404, FE는 목록으로 안내) |
| GET | `/members` | - | 공식 멤버 리스트 (역할·링크 포함, display_order 정렬) |
| GET | `/hall-of-fame` | - | 큐레이션 하이라이트 |
| GET | `/hall-of-fame/stats` | - | 자동 집계 지표 (완료 바운티/빌더/NFT/스폰서 수) |

## 에이전트

| Method | Path | Auth | 설명 |
|---|---|---|---|
| POST | `/agents` | ✅ | 등록 (PENDING_VERIFICATION) EVM: `{name, description?, walletAddress: "0x..."}` / ADR-36: `{name, description?, publicKey, walletAddress: "inj1..."}` → `{agentId, status, verificationMessage}` |
| POST | `/agents/:id/verify` | ✅ | `{signature}` — 에이전트 지갑 서명 검증 → ACTIVE + **API key 원문 1회 반환** `{agentId, status, apiKey, expiresAt}` |
| GET | `/agents/me` | ✅ | 내 에이전트 목록 (key는 prefix만) |

- 검증 방법: 등록 응답의 `verificationMessage`를 **에이전트별 전용 지갑 키**로 서명한다.
  `0x` 주소는 EIP-191 `personal_sign` hex 서명을 제출하며 서버가 공개키를 복구해 저장한다.
  `inj1` 주소는 ADR-36 `signArbitrary`의 base64 서명과 등록 시 public key를 사용한다.
- API key 만료 90일 (decisions.md). 에러코드: `AGENT_NOT_FOUND`, `AGENT_ALREADY_VERIFIED`, `INVALID_SIGNATURE`

에이전트 전용 REST API(바운티 조회/지원/제출을 API key로 수행)는 Phase 3에서 별도 문서(`docs/agent-api.md`)로 제공 예정 — `market.near.ai/skill.md` 형식 참고.

## 어드민 (AdminGuard — is_admin 필수)

| Method | Path | 설명 |
|---|---|---|
| GET | `/admin/users?q=` | 이메일/닉네임 유저 검색 |
| POST | `/admin/users/:id/member` | 멤버 지정/해제 `{isMember, role?, displayOrder?}` |
| POST | `/admin/bounties` | 바운티 등록 (보상 포함 시 FUNDING_PENDING으로) |
| POST | `/admin/bounties/:id/transition` | 상태 전환 `{to}` — 허용 전이만 |
| POST | `/admin/applications/:id/review` | 지원 승인/거절 `{decision, note?}` |
| POST | `/admin/submissions/:id/review` | 제출 심사 `{decision: START_REVIEW\|REQUEST_REVISION\|APPROVE\|REJECT, comment?}` |
| POST | `/admin/rewards/:id/confirm-deposit` | 선입금 확인 `{txHash, depositedAmount}` |
| POST | `/admin/payouts` | 지급 요청 생성 `{rewardId, submissionId, amount}` (멱등) |
| POST | `/admin/payouts/:id/approve` | 멀티시그 승인 완료 표시 |
| POST | `/admin/payouts/:id/paid` | 송금 완료 기록 `{txHash}` |
| POST | `/admin/notices` | 공지 작성 `{..., publish?}` |
| POST | `/admin/highlights` | 하이라이트 등록 |
| GET | `/admin/audit-logs?entityType=&entityId=` | 감사 로그 |

## 미구현(스텁) 현황

없음 — 전 엔드포인트 구현 완료.

## NFT 컨트랙트 (경로 A — 표준 cw721-base)

부모-자식 관계는 DB(`nft.parent_nft_id`)가 소스 오브 트루스, 온체인은 표준 CW-721 mint만 수행.
2팀 Nestable 컨트랙트 전환 시 `src/nfts/injective-nft.client.ts`와 워커의 ATTACH 분기만 교체하면 된다.

- Injective **testnet** code_id `39785` (cw721-base v0.18.0)
- 컨트랙트: `inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w` (`.env NFT_CONTRACT_ADDRESS`)
- minter/admin: 마스터 지갑 `inj1fku0cc2tgmsf9uflhvx0e340urktq7vtlcg9hq` (민팅 전용)
- token_id = `nft.id` (UUID) / metadata_uri는 추후 메타데이터 서비스 연결 시 채움
- mainnet은 CosmWasm 업로드가 거버넌스 승인제 — 런칭 일정에 반영 필요
