import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 공개 목록 공통 페이지네이션 쿼리 — `page=abc` 같은 값은 500이 아니라 400으로 거절한다.
 * 기본값은 엔드포인트마다 다르므로(바운티 12, 공지 10) 컨트롤러에서 `?? 기본값`으로 채운다.
 */
export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize?: number;
}
