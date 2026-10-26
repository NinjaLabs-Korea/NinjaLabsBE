/**
 * 서비스가 던지는 에러 코드 카탈로그 — 코드 → HTTP 상태 → 한 줄 의미(한국어).
 *
 * 응답은 Nest 기본 포맷 `{ statusCode, message: "ERROR_CODE", error }`이고 `message`가 곧 이 코드다 (docs/api-contract.md "공통 규칙").
 * FE는 이 `message` 문자열로 분기·번역하므로 **코드 문자열 자체가 공개 계약**이다. 이름을 바꾸면 FE가 깨진다.
 *
 * ## 어디를 고치나
 * - **새 코드를 던질 때**: 서비스에 `throw new XxxException('NEW_CODE')`를 쓰고 → 아래 `ERROR_CODES`에 항목 추가 →
 *   `docs/api-contract.md`의 "에러 코드" 표(BEGIN/END 표식 사이)에 같은 행 추가. 셋 중 하나라도 빠지면
 *   `error-codes.spec.ts`가 실패한다 (소스 ↔ 카탈로그 ↔ 문서 양방향 검사, 상태 코드까지 대조).
 * - **코드를 지울 때**: 소스에서 마지막 throw가 사라지면 카탈로그·문서 행도 지운다 (스펙이 "카탈로그에만 있는 코드"를 잡는다).
 * - **같은 코드를 다른 상태로 던질 때**(예: `BOUNTY_NOT_FOUND`가 404/400): `statuses`에 둘 다 적는다. 가능하면 상태를 통일하는 편이 낫다.
 *
 * ## 이 파일이 다루지 않는 것
 * - 서비스의 리터럴은 그대로 둔다 (런타임이 이 카탈로그를 import하지 않는다 — 스펙만 정적 스캔으로 대조한다).
 * - class-validator가 만드는 DTO 검증 메시지(`nickname must be ...` 등)와 `blockers` 영어 문장(BountyLifecycleService),
 *   throttler 429, body-parser 오류는 "코드"가 아니라 여기에 없다.
 * - `INVALID_TRANSITION`은 실제 메시지가 `INVALID_TRANSITION:<from>-><to>` 형태다 (접두사가 코드).
 */

export type ErrorCodeEntry = {
  /** 이 코드가 응답으로 나갈 수 있는 HTTP 상태 (오름차순). 대부분 하나다. */
  readonly statuses: readonly number[];
  /** 한 줄 의미 (운영자/FE 개발자가 읽는 설명 — 사용자 노출 문구가 아니다, 사용자 문구는 FE messages가 소유) */
  readonly ko: string;
};

export const ERROR_CODES = {
  // ── 인증 / 세션 (auth) ──
  MISSING_BEARER_TOKEN: { statuses: [401], ko: 'Authorization: Bearer 헤더가 없다' },
  INVALID_ACCESS_TOKEN: { statuses: [401], ko: 'access token이 위조·만료됐거나 세션이 폐기됐다 (FE는 refresh 후 1회 재시도)' },
  INVALID_REFRESH_TOKEN: { statuses: [401], ko: 'refresh token이 없거나 만료·폐기·재사용 감지됐다 (재로그인 필요)' },
  INVALID_LOGIN_CODE: { statuses: [401], ko: '일회용 로그인 코드가 없거나 만료·이미 사용됐다' },
  INVALID_CODE_CHALLENGE: { statuses: [401], ko: 'PKCE code_challenge 형식이 올바르지 않다' },
  INVALID_OAUTH_STATE: { statuses: [401], ko: 'OAuth state가 변조됐거나 만료됐다' },
  GOOGLE_CODE_EXCHANGE_FAILED: { statuses: [401], ko: 'Google 인가 코드 교환이 실패했다' },
  INVALID_GOOGLE_ID_TOKEN: { statuses: [401], ko: 'Google id_token 서명·발급자·대상(aud) 검증에 실패했다' },
  GOOGLE_EMAIL_NOT_VERIFIED: { statuses: [401], ko: 'Google 계정 이메일이 인증되지 않았다' },
  GOOGLE_UNAVAILABLE: { statuses: [503], ko: 'Google 서명 키/엔드포인트에 일시적으로 닿지 못했다 (재시도 가능)' },
  ACCOUNT_CONFLICT: { statuses: [409], ko: '같은 이메일/Google 계정의 활성 유저와 충돌했다 (동시 첫 로그인 등; 콜백은 #error=AUTH_FAILED로 보낸다)' },
  ADMIN_ONLY: { statuses: [403], ko: '운영자(is_admin)만 호출할 수 있다' },
  TURNSTILE_FAILED: { statuses: [400], ko: 'Turnstile 봇 검증 토큰이 없거나 거부됐다' },
  TURNSTILE_UNAVAILABLE: { statuses: [503], ko: 'Turnstile 검증 서버에 닿지 못했다' },

  // ── 유저 / 탈퇴 ──
  USER_NOT_FOUND: { statuses: [404], ko: '대상 유저가 없다 (탈퇴 포함)' },
  PROFILE_REQUIRED: { statuses: [409], ko: '프로필(닉네임·자기소개·태그)을 저장하기 전에는 온보딩을 완료할 수 없다. 온보딩을 마치지 않은 사람(과 그 사람이 소유한 에이전트)은 에이전트 등록·바운티 지원·제출도 같은 코드로 막힌다' },
  NICKNAME_CHANGE_COOLDOWN: { statuses: [409], ko: '닉네임을 이미 정한 유저가 24시간 안에 또 바꾸려 했다 (변경은 감사 USER_NICKNAME_CHANGED로 남고 마지막 변경 24시간 뒤에 다시 가능)' },
  NICKNAME_TAKEN: { statuses: [409], ko: '이미 사용 중인 닉네임이다' },
  CONFIRM_NICKNAME_MISMATCH: { statuses: [400], ko: '탈퇴 확인용 닉네임 입력이 현재 닉네임과 다르다' },
  WITHDRAWAL_BLOCKED_OPEN_PAYOUTS: { statuses: [409], ko: '진행 중인 지급(payout)이 있어 탈퇴할 수 없다' },
  WITHDRAWAL_BLOCKED_PENDING_REWARDS: { statuses: [409], ko: '입금 대기 중인 보상이 걸려 있어 탈퇴할 수 없다' },

  // ── 지갑 ──
  INVALID_INJECTIVE_ADDRESS: { statuses: [400], ko: 'Injective 주소(inj1… 또는 0x…) 형식이 올바르지 않다' },
  CHALLENGE_NOT_FOUND: { statuses: [400], ko: '발급된 지갑 challenge가 없다 (먼저 challenge 요청)' },
  CHALLENGE_EXPIRED: { statuses: [400], ko: 'challenge가 만료됐거나 이미 사용됐다' },
  INVALID_SIGNATURE: { statuses: [401], ko: '서명 검증에 실패했다 (지갑 연결·에이전트 등록 공통)' },
  WALLET_ALREADY_LINKED: { statuses: [409], ko: '이 주소가 이미 다른 계정에 연결됐거나, 내 대표 지갑이 이미 있다 (부분 유니크 인덱스 충돌)' },

  // ── 에이전트 ──
  INVALID_AGENT_WALLET_ADDRESS: { statuses: [400], ko: '에이전트 지갑 주소 형식이 올바르지 않다' },
  AGENT_PUBLIC_KEY_REQUIRED: { statuses: [400], ko: '에이전트 공개키가 필요하다' },
  AGENT_PUBLIC_KEY_MISMATCH: { statuses: [400], ko: 'inj1 에이전트의 공개키가 그 지갑 주소의 키가 아니다' },
  AGENT_WALLET_IS_OWNER_WALLET: { statuses: [400], ko: '에이전트 지갑이 소유자 본인의 연결 지갑과 같다 (전용 에이전트 지갑을 써야 한다). 등록 때뿐 아니라 `POST /wallets/verify`가 내 에이전트의 지갑을 대표 지갑으로 묶을 때도' },
  AGENT_KEY_OR_WALLET_ALREADY_REGISTERED: { statuses: [409], ko: '같은 공개키 또는 지갑으로 이미 등록된 에이전트가 있다' },
  AGENT_NOT_FOUND: { statuses: [404], ko: '내 에이전트가 아니거나 없다' },
  AGENT_ALREADY_VERIFIED: { statuses: [409], ko: '이미 검증이 끝난 에이전트다' },
  AGENT_NOT_ACTIVE: { statuses: [409], ko: 'ACTIVE 상태가 아니어서 키 회전 등을 할 수 없다' },
  MISSING_AGENT_API_KEY: { statuses: [401], ko: 'Agent API 키 헤더가 없다' },
  INVALID_AGENT_API_KEY: { statuses: [401], ko: 'Agent API 키가 없거나 만료·폐기됐다' },
  AGENT_SUBMISSION_REQUIRED: { statuses: [400], ko: '에이전트 제출 전용 바운티인데 사람이 직접 요청했다' },
  DIRECT_SUBMISSION_REQUIRED: { statuses: [400], ko: '직접 제출 전용 바운티인데 에이전트가 요청했다' },

  // ── 바운티 (공개/어드민) ──
  BOUNTY_NOT_FOUND: { statuses: [400, 404], ko: '바운티가 없거나 비공개다 (하이라이트 생성에서 존재하지 않는 bountyId는 400)' },
  BOUNTY_NOT_OPEN: { statuses: [400], ko: '지원/제출을 받는 상태(OPEN 등)가 아니다' },
  BOUNTY_REVIEW_CLOSED: { statuses: [400], ko: '바운티가 이미 종료돼 심사·보상 처리를 할 수 없다' },
  BOUNTY_HAS_OPEN_FUNDS: { statuses: [409], ko: '미정산 보상·지급이 남아 있어 삭제할 수 없다' },
  APPLICATION_DEADLINE_AFTER_SUBMISSION_DEADLINE: { statuses: [400], ko: '지원 마감이 제출 마감보다 늦다 (생성·수정 모두, 같은 시각은 허용)' },
  DEADLINE_IN_PAST: { statuses: [400], ko: '마감일을 과거로 바꿀 수 없다' },
  MAX_WINNERS_BELOW_APPROVED: { statuses: [400], ko: '이미 승인된 수보다 적게 최대 당선자 수를 줄일 수 없다' },
  INVALID_TRANSITION: { statuses: [400], ko: '허용되지 않는 상태 전이다 (실제 메시지는 INVALID_TRANSITION:<from>-><to>)' },
  REWARD_TOKEN_DENOM_REQUIRED: { statuses: [400], ko: '보상 토큰 denom이 필요하다' },
  REWARD_TOKEN_CONTRACT_REQUIRED: { statuses: [400], ko: '보상 토큰 컨트랙트 주소가 필요하다' },
  REWARD_EVM_METADATA_REQUIRED: { statuses: [400], ko: 'EVM 보상 토큰의 메타데이터(컨트랙트·체인)가 필요하다' },
  USDC_EVM_CONTRACT_NOT_CONFIGURED: { statuses: [400], ko: '서버에 USDC EVM 컨트랙트 주소 설정이 없다 (운영 env)' },
  INJECTIVE_EVM_CHAIN_NOT_CONFIGURED: { statuses: [400], ko: '서버에 Injective EVM 체인 ID 설정이 없다 (운영 env)' },

  // ── 지원 (applications) ──
  SUBMISSION_TYPE_BOUNTY: { statuses: [400], ko: '제출형 바운티는 지원 없이 바로 제출한다' },
  APPLICATION_DEADLINE_PASSED: { statuses: [400], ko: '지원/제출 마감이 지났다' },
  ALREADY_APPLIED: { statuses: [409], ko: '이미 지원했다 (철회 상태만 재지원 가능)' },
  APPLICATION_NOT_FOUND_OR_NOT_PENDING: { statuses: [404], ko: '지원서가 없거나 PENDING이 아니라 처리할 수 없다' },
  APPLICATION_APPROVAL_CLOSED: { statuses: [400], ko: '바운티 상태상 더 이상 지원을 승인할 수 없다' },
  APPLICATION_NOT_APPROVED: { statuses: [403], ko: '승인된 지원자만 제출할 수 있다' },

  // ── 제출 / 심사 (submissions) ──
  DEADLINE_PASSED: { statuses: [400], ko: '제출 마감이 지났다 (수정 요청 상태의 재제출은 예외)' },
  SUBMISSION_FINALIZED: { statuses: [409], ko: '이미 확정(승인/반려)된 제출이라 수정할 수 없다' },
  SUBMISSION_NOT_FOUND: { statuses: [404], ko: '제출물이 없다' },
  SUBMISSION_NOT_REVIEWABLE: { statuses: [400], ko: '심사 가능한 상태의 제출이 아니다' },
  SUBMISSION_REVISION_CHANGED: { statuses: [400], ko: '심사 중에 제출이 재제출돼 리비전이 바뀌었다 (새로고침 후 다시 심사)' },
  REVISION_COMMENT_REQUIRED: { statuses: [400], ko: '수정 요청에는 코멘트가 필요하다' },
  MAX_WINNERS_REACHED: { statuses: [400], ko: '최대 당선자 수에 도달해 더 승인할 수 없다' },
  INVALID_DECISION: { statuses: [404], ko: '알 수 없는 심사 결정 값이다 (404로 나가는 것이 현행 계약)' },

  // ── 보상 / 지급 (rewards) ──
  INVALID_TX_HASH: { statuses: [400], ko: '트랜잭션 해시 형식이 올바르지 않다' },
  INVALID_TOKEN_AMOUNT: { statuses: [400], ko: '토큰 금액이 최소 단위 양의 정수 문자열이 아니다' },
  TX_HASH_ALREADY_USED: { statuses: [409], ko: '이미 다른 입금/지급에 쓰인 tx hash다 (중복 사용 불가)' },
  REWARD_NOT_FOUND: { statuses: [404], ko: '보상 행이 없다' },
  DEPOSIT_BELOW_REWARD_AMOUNT: { statuses: [400], ko: '입금액이 보상 게시 금액(amount)보다 적어 입금 확인을 할 수 없다' },
  REWARD_NOT_FOUND_OR_NOT_PENDING: { statuses: [404], ko: '보상이 없거나 입금 대기(DEPOSIT_PENDING) 상태가 아니다' },
  REWARD_NOT_FUNDED: { statuses: [400], ko: '보상이 없거나 입금 확인(FUNDED 이상)이 안 돼 지급을 요청할 수 없다' },
  APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND: { statuses: [404], ko: '승인된 제출이 없거나 수령자의 지갑이 연결돼 있지 않다' },
  APPROVED_SUBMISSION_NOT_FOUND: { statuses: [404], ko: '해당 지급의 승인된 제출이 없다' },
  PAYOUT_ALREADY_REQUESTED: { statuses: [409], ko: '같은 제출에 이미 지급 요청이 있다 (멱등)' },
  PAYOUT_EXCEEDS_AVAILABLE_REWARD: { statuses: [400], ko: '지급액이 남은 보상 잔액을 넘는다' },
  PAYOUT_NOT_FOUND_OR_WRONG_STATUS: { statuses: [404], ko: '지급이 없거나 현재 상태에서 허용되지 않는 처리다' },
  PAYOUT_SELF_APPROVAL: { statuses: [403], ko: '지급 요청자 본인이 승인할 수 없다 (PAYOUT_ALLOW_SELF_APPROVAL로만 허용)' },

  // ── 콘텐츠 (notices / highlights / members / media / nfts) ──
  NOTICE_NOT_FOUND: { statuses: [404], ko: '공지가 없다' },
  // ── 기수 모집 (cohorts) ──
  COHORT_NOT_FOUND: { statuses: [404], ko: '기수가 없다 (DRAFT 기수는 지원자에게도 없는 것과 같다)' },
  COHORT_NOT_ACCEPTING: { statuses: [409], ko: '지금 지원을 받지 않는 기수다 (OPEN이 아니거나 접수 기간 밖; 지원서 수정에도 같은 규칙)' },
  COHORT_ALREADY_APPLIED: { statuses: [409], ko: '이 기수에 이미 지원했다 (철회한 지원만 같은 행을 다시 열어 재지원)' },
  COHORT_APPLICATION_NOT_FOUND: { statuses: [404], ko: '기수 지원서가 없거나 내 것이 아니다 (남의 지원서도 같은 404)' },
  COHORT_APPLICATION_NOT_SUBMITTED: { statuses: [409], ko: 'SUBMITTED가 아니라 수정·철회할 수 없다 (이미 심사됨/철회됨)' },
  COHORT_APPLICATION_WITHDRAWN: { statuses: [409], ko: '철회된 지원서라 심사할 수 없다' },
  COHORT_OTHER_DETAIL_REQUIRED: { statuses: [400], ko: '활동 유형 또는 관심 분야에 OTHER를 골랐는데 상세(activityTypeOther/interestOther)가 비었다' },
  COHORT_INVALID_WINDOW: { statuses: [400], ko: '접수 종료(closesAt)가 시작(opensAt)보다 늦지 않다' },
  COHORT_INVALID_TRANSITION: { statuses: [400], ko: '허용되지 않는 기수 상태 전이다 (DRAFT->OPEN->CLOSED, CLOSED->OPEN만)' },
  COHORT_ALREADY_OPEN: { statuses: [409], ko: '다른 기수가 이미 OPEN이다 (동시에 열린 기수는 하나)' },
  COHORT_HAS_APPLICATIONS: { statuses: [409], ko: '지원서가 있는 기수는 삭제할 수 없다 (철회 포함)' },
  HIGHLIGHT_NOT_FOUND: { statuses: [404], ko: '하이라이트가 없다' },
  NFT_JOB_NOT_FOUND_OR_NOT_FAILED: { statuses: [404], ko: 'NFT 작업이 없거나 FAILED가 아니라 재시도할 수 없다' },
  MEDIA_FILE_REQUIRED: { statuses: [400], ko: '업로드 파일이 없다' },
  MEDIA_FILE_TOO_LARGE: { statuses: [400], ko: '업로드 파일이 크기 상한을 넘는다' },
  MEDIA_FILE_TYPE_UNSUPPORTED: { statuses: [400], ko: '허용되지 않는 이미지 형식이다 (시그니처 검사)' },
  MEDIA_NOT_FOUND: { statuses: [404], ko: '미디어가 없다' },

  // ── 공통 (DB 오류 매핑 — common/database/pg-errors.ts) ──
  INVALID_CHARACTER: { statuses: [400], ko: '요청 값에 DB가 거부하는 문자(NUL 등)가 있다' },
  INVALID_DATE: { statuses: [400], ko: '요청 값의 날짜/시각이 달력에 없다 (예: 2월 31일)' },
  REFERENCE_NOT_FOUND: { statuses: [400], ko: '참조하는 대상 행이 없다 (FK 위반)' },
  DATABASE_UNAVAILABLE: { statuses: [503], ko: 'DB 연결 풀/응답 타임아웃·연결 끊김/거부 (재시도 가능)' },
} as const satisfies Record<string, ErrorCodeEntry>;

export type ErrorCode = keyof typeof ERROR_CODES;
