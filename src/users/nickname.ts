import { Transform } from 'class-transformer';
import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * 닉네임 규칙 — URL 경로 `/users/:nickname`에 그대로 쓰인다.
 *   - 유니코드 문자/숫자와 `_ . -`만, 공백 불가
 *   - 처음과 끝은 문자/숫자 (`.ninja`, `ninja-`, `...`, `--` 불가 → 경로 세그먼트 `.`/`..`·구분자 혼동 방지)
 *   - 한글 채움 문자(U+115F, U+1160, U+3164, U+FFA0)는 불가 — 범주가 문자(Lo)라 정규식을 통과하지만 화면에는 빈칸으로 그려져 "보이지 않는 이름"이 된다
 *   - 전각/반각 문자(U+FF00 블록)와 수학용 영숫자(U+1D400 블록)는 불가 - `ａｄｍｉｎ`처럼 NFKC로 라틴 글자가 되는 모양만 같은 문자로 예약어·기존 이름을 사칭한다
 *   - 라틴 글자와 키릴/그리스 글자를 한 이름에 섞는 것은 불가 (`аdmin`의 키릴 а, `buіlderone`의 키릴 і 같은 혼합 문자 동형이의어)
 *   - 길이 2~50 (DTO의 @Length)
 *   - 라우트와 충돌하는 예약어(`me`, `check-nickname`, `admin`, `new`, `edit`)는 대소문자 무관 거부
 *   - 탈퇴 익명화 이름의 접두사 `withdrawn_`(대소문자 무관)도 거부 — 남은 제출/payout 기록에 표시되는 탈퇴자 이름을 사칭하지 못하게
 *   - 정적 파일 확장자(`.png`, `.json`, … — STATIC_FILE_EXTENSIONS)로 끝나는 이름 거부 (대소문자 무관)
 */
export const NICKNAME = /^(?!.*[\u115F\u1160\u3164\uFFA0\uFF00-\uFFEF\u{1D400}-\u{1D7FF}])(?!(?=.*[A-Za-z\u00C0-\u024F])(?=.*[\p{Script=Cyrillic}\p{Script=Greek}]))[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]$/u;

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

/**
 * 닉네임의 정규형 — 앞뒤 공백 제거 + 유니코드 NFC. 한글 자모(U+1100…)로 풀어 쓴 "한"과 완성형 "한"은 화면에서 구별되지 않지만
 * 다른 문자열이라 `lower(nickname)` 유니크 인덱스가 둘을 따로 받아 줬다(사칭). 저장·중복검사·조회·탈퇴 확인 모두 이 값으로 비교한다.
 */
export function normalizeNickname(value: string): string {
  return value.trim().normalize('NFC');
}

export function endsWithStaticFileExtension(value: unknown): boolean {
  return typeof value === 'string' && STATIC_FILE_SUFFIX.test(value.trim());
}

/**
 * 라틴 글자와 모양이 같은 키릴/그리스 글자 -> 라틴. 혼합 문자 이름은 NICKNAME이 이미 막지만, 전부 키릴/그리스로만 쓴 예약어 닮은꼴은 이 접기로 잡는다.
 * 전체 confusables 표가 아니라 소문자 동형 글자만 (예약어 비교용) - 기존 사용자 이름과의 동형 충돌은 혼합 문자 금지로 막는다.
 */
const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h', 'ո': 'n',
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'χ': 'x', 'υ': 'u',
};

/** 예약어 비교용 골격 - NFKC(전각 -> 반각 등) + 소문자 + 키릴/그리스 동형 글자를 라틴으로 */
function nicknameSkeleton(value: string): string {
  return [...value.trim().normalize('NFKC').toLowerCase()].map((char) => CONFUSABLE_TO_LATIN[char] ?? char).join('');
}

export function isReservedNickname(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = nicknameSkeleton(value);
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
  const nickname = normalizeNickname(value);
  const length = [...nickname].length;
  return length >= NICKNAME_MIN_LENGTH && length <= NICKNAME_MAX_LENGTH && NICKNAME.test(nickname) && !isReservedNickname(nickname) && !endsWithStaticFileExtension(nickname);
}

/** DTO 변환 — 닉네임 입력을 normalizeNickname으로 (문자열이 아니면 그대로 두어 @IsString이 거부한다) */
export const NormalizeNickname = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? normalizeNickname(value) : value));

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
