import { Transform } from 'class-transformer';
import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * 화면에 아무것도 그리지 않는 문자들: 제로폭 공백·방향 제어·BOM 등 서식 문자(Cf), 제어 문자(Cc), 공백류(Z*), 한글 채움 문자, 점자 빈칸(U+2800, 범주가 기호(So)라 \p{Z}에 안 걸린다).
 * `trim()`은 ASCII/일부 유니코드 공백만 지워서 U+200B(제로폭 공백) 같은 것만으로 된 문자열은 `@IsNotEmpty()`를 통과한다.
 * 닉네임 규칙(users/nickname.ts)이 이미 같은 이유로 한글 채움 문자를 거부한다 - 제목·이름 같은 표시용 필수 문자열은 이 검사를 쓴다.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Z}\p{Co}\p{Cn}\p{Cs}\uFFFC\u2800]/gu;

/**
 * 보이는 글자가 하나라도 있는가. 유니코드 Default_Ignorable_Code_Point(결합 자소 결합자 U+034F, 크메르 U+17B4/17B5, 몽골 변이 선택자 U+180B-180F,
 * U+FE0F, 소프트 하이픈, 한글 채움 문자 등), 개체 대체 문자 U+FFFC, 사용자 정의(Co)·미할당(Cn) 코드 포인트도 보이지 않는 문자로 본다.
 * 결합 문자(\p{M})만 남은 값("́")도 기본 글자 없이는 화면에 글자로 그려지지 않으므로 보이는 글자가 아니다.
 */
export function hasVisibleText(value: unknown): boolean {
  return typeof value === 'string' && /[^\p{M}]/u.test(value.replace(INVISIBLE, ''));
}

/** DTO 데코레이터 - 보이지 않는 문자만으로 된 값을 거부한다 (`@IsNotEmpty()`와 함께 쓴다) */
export const HasVisibleText = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'hasVisibleText',
      validator: {
        validate: (value) => hasVisibleText(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must contain visible characters`, options),
      },
    },
    options,
  );

/**
 * 표시 이름에 들어가면 안 되는 문자: 줄바꿈·탭 등 제어 문자(Cc), 줄/문단 구분자(U+2028/2029), 방향 제어(U+200E/200F, U+202A-202E, U+2066-2069),
 * 제로폭 공백(U+200B)·워드 조이너(U+2060)·BOM(U+FEFF). RLO(U+202E)는 "Trusted Admin Bot"을 거꾸로 그리고 개행은 가짜 두 번째 줄을 만든다.
 * 이모지/인도계 문자가 쓰는 ZWJ(U+200D)·ZWNJ(U+200C)는 허용한다.
 */
const DISPLAY_NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

export function isPlainDisplayText(value: unknown): boolean {
  return typeof value === 'string' && !DISPLAY_NAME_FORBIDDEN.test(value);
}

/** DTO 데코레이터 - 한 줄 표시 이름에서 제어·방향 제어 문자를 거부한다 (`@Trim()` 뒤에 둔다: 앞뒤 공백은 이미 지워진다) */
export const IsPlainDisplayText = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isPlainDisplayText',
      validator: {
        validate: (value) => isPlainDisplayText(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must not contain control, line-break or bidirectional formatting characters`, options),
      },
    },
    options,
  );

/**
 * 글 순서를 뒤집는 방향 제어 문자: 임베딩/오버라이드(U+202A-202E)와 격리(U+2066-2069). RLO(U+202E) 하나가 뒤따르는 글을 거꾸로 그린다.
 * 여러 줄 본문(자기소개 등)용 - 줄바꿈은 허용해야 하므로 IsPlainDisplayText를 못 쓴다. 아랍어·히브리어 본문이 쓰는 암묵 표식(U+200E/200F)은 허용한다.
 */
const BIDI_REORDERING = /[\u202A-\u202E\u2066-\u2069]/u;

export function hasNoBidiOverride(value: unknown): boolean {
  return typeof value === 'string' && !BIDI_REORDERING.test(value);
}

/** DTO 데코레이터 - 방향 임베딩/오버라이드/격리 문자를 거부한다 (여러 줄 본문용) */
export const HasNoBidiOverride = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'hasNoBidiOverride',
      validator: {
        validate: (value) => hasNoBidiOverride(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must not contain bidirectional override characters`, options),
      },
    },
    options,
  );

/**
 * 선택 입력용 변환 - 앞뒤 공백을 지우고, 보이는 글자가 없으면(빈 값, 공백, 제로폭 문자만) null로 바꾼다.
 * `@IsOptional()`이 null을 통과시키므로 "없음"으로 취급된다: 심사 코멘트가 필수인 결정은 서비스가 400 `REVISION_COMMENT_REQUIRED`로 거부하고,
 * 선택 요약은 NULL로 저장된다 (보이지 않는 요약이 빈 줄로 그려지지 않게).
 */
export const NullIfInvisible = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return hasVisibleText(trimmed) ? trimmed : null;
  });

/**
 * 몰수 표식 - scripts/forfeit-award.js가 심사 코멘트를 `forfeited: <사유>`로 시작해 남기고, 제출자 화면(FE `parseReviewComment`)이 이 접두사를
 * "승인됐지만 수상이 몰수됨"으로 해석한다. 표식이 코멘트 본문 안에 있으므로 운영자가 API로 쓴 일반 반려 코멘트가 같은 접두사로 시작하면
 * 제출자는 "승인됐지만 몰수"로 오해한다 -> API 심사 코멘트는 이 접두사로 시작할 수 없다 (대소문자·앞 공백 무관).
 */
const FORFEIT_MARKER = /^\s*forfeited\s*:/i;

export function isForfeitMarker(value: unknown): boolean {
  return typeof value === 'string' && FORFEIT_MARKER.test(value);
}

/** DTO 데코레이터 - `forfeited:`로 시작하는 심사 코멘트 거부 (null/undefined는 통과: IsOptional과 함께 쓴다) */
export const IsNotForfeitMarker = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isNotForfeitMarker',
      validator: {
        validate: (value) => !isForfeitMarker(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must not start with the reserved prefix "forfeited:" (it marks an award taken back by the ops script)`, options),
      },
    },
    options,
  );
