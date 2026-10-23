import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * 닉네임 규칙 — URL 경로 `/users/:nickname`에 그대로 쓰인다.
 *   - 유니코드 문자/숫자와 `_ . -`만, 공백 불가
 *   - 처음과 끝은 문자/숫자 (`.ninja`, `ninja-`, `...`, `--` 불가 → 경로 세그먼트 `.`/`..`·구분자 혼동 방지)
 *   - 길이 2~50 (DTO의 @Length)
 *   - 라우트와 충돌하는 예약어(`me`, `check-nickname`, `admin`, `new`, `edit`)는 대소문자 무관 거부
 */
export const NICKNAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]$/u;

export const RESERVED_NICKNAMES: readonly string[] = ['me', 'check-nickname', 'admin', 'new', 'edit'];

export function isReservedNickname(value: unknown): boolean {
  return typeof value === 'string' && RESERVED_NICKNAMES.includes(value.trim().toLowerCase());
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
