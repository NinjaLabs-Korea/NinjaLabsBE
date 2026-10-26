import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * 화면에 아무것도 그리지 않는 문자들: 제로폭 공백·방향 제어·BOM 등 서식 문자(Cf), 제어 문자(Cc), 공백류(Z*), 한글 채움 문자.
 * `trim()`은 ASCII/일부 유니코드 공백만 지워서 U+200B(제로폭 공백) 같은 것만으로 된 문자열은 `@IsNotEmpty()`를 통과한다.
 * 닉네임 규칙(users/nickname.ts)이 이미 같은 이유로 한글 채움 문자를 거부한다 - 제목·이름 같은 표시용 필수 문자열은 이 검사를 쓴다.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Z}ᅟᅠㅤﾠ]/gu;

/** 보이는 글자가 하나라도 있는가 */
export function hasVisibleText(value: unknown): boolean {
  return typeof value === 'string' && value.replace(INVISIBLE, '').length > 0;
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
