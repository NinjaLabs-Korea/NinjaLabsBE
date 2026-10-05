import { Transform } from 'class-transformer';

/**
 * 문자열 입력의 앞뒤 공백을 제거한다. `@IsNotEmpty()`와 함께 쓰면 공백만 있는 값("   ")도 빈 값으로 거절된다.
 * 전역 ValidationPipe가 `transform: true`라서 DTO 필드에 붙이기만 하면 적용된다.
 */
export const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
