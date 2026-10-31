/**
 * `user.onboarding_step` 값의 단일 출처. FE는 `/auth/me`의 `onboardingStep`으로 가입 화면을 고른다(docs/api-contract.md "/auth/me").
 * 숫자는 FE 가입 단계(1 구글 로그인 -> 2 지갑 -> 3 프로필 -> 완료)와 같다. 값을 바꾸면 운영 DB의 기존 행과 FE 분기가 같이 바뀌므로
 * 값은 그대로 두고 이름만 쓴다.
 *
 * 의존성 없는 모듈이다(auth, users, wallets가 import한다). SQL에는 `${ONBOARDING_STEP.X}`로 숫자 리터럴을 그대로 끼운다:
 * 상수라 바인딩이 필요 없고, 렌더링된 문장이 이전과 같다(onboarding-step.spec.ts).
 */
export const ONBOARDING_STEP = {
  /** 구글 로그인(1단계)을 마친 새 유저 - 다음 화면은 지갑 연결. 첫 로그인의 INSERT 값 */
  WALLET: 2,
  /** 지갑을 연결했다 - 다음 화면은 프로필. 지갑 연결은 `GREATEST(onboarding_step, 3)`로 올리기만 한다 */
  PROFILE: 3,
  /** 프로필(닉네임·자기소개·태그)을 저장했다 - 온보딩 완료 플래그를 찍을 수 있고, 이후 닉네임 변경은 쿨다운·감사 대상 */
  PROFILE_SAVED: 4,
} as const;
