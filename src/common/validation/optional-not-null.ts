import { applyDecorators } from '@nestjs/common';
import { IsDefined, Max, ValidateIf, ValidationOptions } from 'class-validator';

/**
 * 수정(PATCH) DTO에서 **NOT NULL 컬럼**에 쓰이는 필드용 - 생략(undefined)은 "바꾸지 않음"으로 통과시키되 `null`은 400으로 막는다.
 * `@IsOptional()`은 null도 건너뛰어, `{ "title": null }`이 그대로 `UPDATE ... SET title = NULL`까지 내려가 23502(not_null_violation) 500이 됐다.
 * nullable 컬럼(URL, application_deadline 등)은 계속 `@IsOptional()`을 쓴다 - 거기서 null은 "값 지우기"다.
 */
export const IsOptionalNotNull = (options?: ValidationOptions) =>
  applyDecorators(
    ValidateIf((_object: object, value: unknown) => value !== undefined),
    IsDefined({ message: '$property should not be null', ...options }),
  );

/** Postgres INTEGER 상한 (2^31 − 1) - 이보다 큰 정수는 22003(numeric_value_out_of_range) 500이 된다 */
export const PG_INT_MAX = 2_147_483_647;

/** INTEGER 컬럼에 저장되는 정수 필드의 상한 */
export const MaxPgInt = (options?: ValidationOptions) => Max(PG_INT_MAX, options);
