import { Transform } from 'class-transformer';

/**
 * 문자열 입력의 앞뒤 공백을 제거한다. `@IsNotEmpty()`와 함께 쓰면 공백만 있는 값("   ")도 빈 값으로 거절된다.
 * 전역 ValidationPipe가 `transform: true`라서 DTO 필드에 붙이기만 하면 적용된다.
 */
export const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * `Trim`과 같지만 공백만 있는(또는 빈) 문자열은 `null`로 바꾼다 - 선택 입력(nullable 컬럼)에 "   "가 그대로 저장돼 소비자가 빈 발췌를 보게 되는 것을 막는다.
 * `@IsOptional()`이 null을 통과시키므로 생성은 NULL 저장, 수정은 값 지우기가 된다.
 */
export const NullIfBlank = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });
