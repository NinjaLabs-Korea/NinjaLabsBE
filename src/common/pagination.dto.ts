import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 공개 목록 공통 페이지네이션 쿼리 - `page=abc` 같은 값은 500이 아니라 400으로 거절한다.
 * 기본값은 엔드포인트마다 다르므로(바운티 12, 공지 10) 컨트롤러에서 `?? 기본값`으로 채운다.
 */
/**
 * page 상한 - 없으면 `page=1000000000000000000`의 OFFSET이 bigint 범위를 넘어 Postgres 22003으로 500이 났다 (인증 없는 공개 목록).
 * 50건 × 100,000쪽 = OFFSET 5,000,000: 실제 데이터보다 한참 크고 정수 범위에는 한참 못 미친다. 감사 로그/유저 검색도 같은 상한을 쓴다.
 */
export const MAX_PAGE = 100_000;

export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize?: number;
}
