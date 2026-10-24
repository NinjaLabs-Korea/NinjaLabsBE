import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { TOKEN_AMOUNT } from '../../common/validation/token-amount';
import { Trim } from '../../common/validation/trim';
import { IsHttpUrlOrMediaPath, IsSafeUrl } from '../../common/validation/url';
import { BountyStatus } from '../bounty-status';
import { RewardInput } from './reward-token.resolver';
import { MaxChars } from '../../common/validation/max-chars';

const CATEGORIES = ['DEV', 'DESIGN', 'CONTENT', 'OTHER'];
const SUBMISSION_MODES = ['DIRECT', 'AGENT'];
/** bounty_reward.token_type CHECK (0011) */
const TOKEN_TYPES = ['NATIVE', 'CW20', 'ERC20'];

/** 보상 입력 — RewardTokenResolver가 읽는 필드만 받는다. USDC는 서버가 env의 컨트랙트/체인으로 덮어쓴다 */
export class RewardDto implements RewardInput {
  @IsIn(TOKEN_TYPES) tokenType!: string;
  @IsOptional() @IsString() @MaxChars(128) tokenDenom?: string;
  @IsOptional() @IsString() @MaxChars(255) tokenContractAddress?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) evmChainId?: number;
  @IsString() @Matches(/^[A-Za-z0-9]{1,12}$/) displaySymbol!: string;
  @IsString() @Matches(TOKEN_AMOUNT) amount!: string;
}

export class CreateBountyDto {
  @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxChars(100) sponsorName!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxLength(500) summary!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxLength(50_000) description!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxLength(20_000) requirements!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxLength(20_000) evaluationCriteria!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsBoolean() applicationRequired!: boolean;
  @IsIn(SUBMISSION_MODES) submissionMode!: string;
  @Type(() => Number) @IsInt() @Min(1) maxWinners!: number;
  @IsDateString() submissionDeadline!: string;
  @IsOptional() @IsDateString() applicationDeadline?: string;
  @IsOptional() @IsHttpUrlOrMediaPath() coverImageUrl?: string;
  @IsOptional() @ValidateNested() @Type(() => RewardDto) reward?: RewardDto;
}

// 수정 요청은 보낸 필드만 검증한다. 다만 필수 텍스트를 빈 값("" 또는 공백)으로 바꾸는 것은 막는다.
// TEXT 컬럼의 상한은 생성의 2배, URL은 완화 규칙(IsSafeUrl) — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로, 엄격 규칙 이전에 저장된 레거시 행이
// 모든 PATCH를 400으로 만들지 않게 한다 (common/validation/url.ts). VARCHAR 컬럼(title 200, sponsor_name 100)은 컬럼 상한 그대로 —
// 완화는 "레거시 모양을 받는다"는 뜻이지 스키마를 넘는다는 뜻이 아니다. MaxChars는 Postgres와 같은 코드 포인트 단위로 센다 (common/validation/max-chars.ts).
export class UpdateBountyDto {
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxChars(100) sponsorName?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(1000) summary?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(100_000) description?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(40_000) requirements?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(40_000) evaluationCriteria?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsBoolean() applicationRequired?: boolean;
  @IsOptional() @IsIn(SUBMISSION_MODES) submissionMode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxWinners?: number;
  @IsOptional() @IsDateString() submissionDeadline?: string;
  @IsOptional() @IsDateString() applicationDeadline?: string | null;
  // null이면 커버 이미지 제거 (IsOptional은 null도 통과시킨다). 레거시 `/uploads/x.png` 같은 값도 통과 (IsSafeUrl)
  @IsOptional() @IsSafeUrl() coverImageUrl?: string | null;
}

/**
 * POST /admin/bounties/:id/transition — 대상 상태만 받는다 (모르는 필드는 전역 ValidationPipe가 400).
 * 값 집합은 bounty-status.ts의 상태 전부 — 지금 상태에서 갈 수 있는지(전이표·차단 사유)는 서비스가 INVALID_TRANSITION / 사유 배열로 답한다.
 */
export class TransitionBountyDto {
  @IsIn(Object.values(BountyStatus)) to!: string;
}
