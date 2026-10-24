import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * 닉네임 규칙 — URL 경로 `/users/:nickname`에 그대로 쓰인다.
 *   - 유니코드 문자/숫자와 `_ . -`만, 공백 불가
 *   - 처음과 끝은 문자/숫자 (`.ninja`, `ninja-`, `...`, `--` 불가 → 경로 세그먼트 `.`/`..`·구분자 혼동 방지)
 *   - 길이 2~50 (DTO의 @Length)
 *   - 라우트와 충돌하는 예약어(`me`, `check-nickname`, `admin`, `new`, `edit`)는 대소문자 무관 거부
 *   - 탈퇴 익명화 이름의 접두사 `withdrawn_`(대소문자 무관)도 거부 — 남은 제출/payout 기록에 표시되는 탈퇴자 이름을 사칭하지 못하게
 *   - 정적 파일 확장자(`.png`, `.json`, … — STATIC_FILE_EXTENSIONS)로 끝나는 이름 거부 (대소문자 무관)
 */
export const NICKNAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]$/u;

export const RESERVED_NICKNAMES: readonly string[] = ['me', 'check-nickname', 'admin', 'new', 'edit'];

/** 탈퇴한 유저의 익명화 닉네임 접두사 (users/account-withdrawal.service.ts가 `withdrawn_<id 8hex>`로 바꾼다) */
export const WITHDRAWN_NICKNAME_PREFIX = 'withdrawn_';

/**
 * FE proxy가 정적 파일로 보고 locale 미들웨어를 건너뛰는 확장자 — 이걸로 끝나는 닉네임은 접두사 없는 프로필 링크(`/users/ninja.png`)가 깨진다.
 * NinjaLabsFE/src/proxy.ts의 `config.matcher` 안 `.*\\.(?:ico|png|…)$` 그룹과 **정확히 같은 목록**이어야 한다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
 */
export const STATIC_FILE_EXTENSIONS: readonly string[] = [
  'ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'txt', 'xml', 'json', 'js', 'css', 'map', 'woff', 'woff2', 'ttf',
];

/** `/\.(ico|png|…)$/i` — 정적 파일 확장자로 끝나는가 (대소문자 무관) */
export const STATIC_FILE_SUFFIX = new RegExp(`\\.(${STATIC_FILE_EXTENSIONS.join('|')})$`, 'i');

export function endsWithStaticFileExtension(value: unknown): boolean {
  return typeof value === 'string' && STATIC_FILE_SUFFIX.test(value.trim());
}

export function isReservedNickname(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return RESERVED_NICKNAMES.includes(normalized) || normalized.startsWith(WITHDRAWN_NICKNAME_PREFIX);
}

/** CompleteProfileDto의 길이 규칙 (@Length(2, 50) — class-validator는 코드 포인트 단위로 센다) */
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 50;

/**
 * POST /users/me/profile 이 받아 줄 닉네임인가 — 같은 trim 뒤 길이·문자 규칙·예약어·정적 파일 확장자를 본다 (중복 여부는 DB가 판단).
 * check-nickname은 이걸 통과해야만 "available"이라고 답한다: 저장이 거부할 값을 사용 가능하다고 말하지 않는다.
 */
export function isSavableNickname(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const nickname = value.trim();
  const length = [...nickname].length;
  return length >= NICKNAME_MIN_LENGTH && length <= NICKNAME_MAX_LENGTH && NICKNAME.test(nickname) && !isReservedNickname(nickname) && !endsWithStaticFileExtension(nickname);
}

/** DTO 데코레이터 — 예약어면 거부 (대소문자 무관) */
export const IsNotReservedNickname = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isNotReservedNickname',
      validator: {
        validate: (value) => !isReservedNickname(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property is a reserved word`, options),
      },
    },
    options,
  );

/** DTO 데코레이터 — 정적 파일 확장자로 끝나면 거부 (대소문자 무관) */
export const IsNotStaticFileNickname = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isNotStaticFileNickname',
      validator: {
        validate: (value) => !endsWithStaticFileExtension(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must not end with a static file extension (.${STATIC_FILE_EXTENSIONS.join(', .')})`, options),
      },
    },
    options,
  );
