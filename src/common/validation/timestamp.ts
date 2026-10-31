import { applyDecorators } from '@nestjs/common';
import { IsDateString, Matches, ValidationOptions } from 'class-validator';

/**
 * TIMESTAMPTZ 컬럼에 저장되는 ISO 8601 문자열 필드용 - `IsDateString`에 "연도 0000 거부"를 더한다.
 * 형식만 보는 `IsDateString`은 `0000-01-01T00:00:00Z`를 통과시키지만 Postgres에는 0년이 없어 22008(datetime_field_overflow) 500이 났다
 * (마감이 이미 지난 COMPLETED/CANCELLED 바운티의 PATCH는 "미래 마감" 검사를 건너뛰어 DB까지 내려간다).
 */
export const IsTimestampString = (options?: ValidationOptions) =>
  applyDecorators(
    IsDateString({ strict: false }, options),
    Matches(/^(?!0000)/, { message: '$property year must not be 0000', ...options }),
  );
