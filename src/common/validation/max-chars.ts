import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * Postgres `char_length()` 기준 길이 — UTF8 DB에서 VARCHAR(n)은 **코드 포인트**를 센다.
 * class-validator의 `MaxLength`/`Length`(validator.js isLength)는 서로게이트 쌍을 1로 세는 것까지는 같지만
 * 이형 선택자(U+FE0E/U+FE0F)를 길이에서 빼므로, `❤️`×150(코드 포인트 300)을 150자로 보고 통과시켜 VARCHAR(200)에서 500이 난다.
 */
export function charLength(value: string): number {
  return [...value].length;
}

/**
 * VARCHAR(n) 컬럼에 저장되는 문자열 필드의 상한 — 컬럼 길이 그대로 쓴다 (수정 DTO의 "완화"는 레거시 모양을 받는다는 뜻이지 스키마를 넘는다는 뜻이 아니다).
 * 문자열이 아니면 통과시킨다 — 타입 검사는 함께 붙는 `@IsString()`의 몫.
 */
export const MaxChars = (max: number, options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'maxChars',
      constraints: [max],
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || charLength(value) <= max,
        defaultMessage: buildMessage(
          (prefix) => `${prefix}$property must be shorter than or equal to $constraint1 characters`,
          options,
        ),
      },
    },
    options,
  );
