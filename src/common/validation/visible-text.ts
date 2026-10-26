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
