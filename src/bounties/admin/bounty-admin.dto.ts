import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { TOKEN_AMOUNT } from '../../common/validation/token-amount';
import { IsTimestampString } from '../../common/validation/timestamp';
import { Trim } from '../../common/validation/trim';
import { HasNoBidiOverride, HasVisibleText, IsPlainDisplayText } from '../../common/validation/visible-text';
import { IsHttpUrlOrMediaPath, IsSafeUrl } from '../../common/validation/url';
import { BountyStatus } from '../bounty-status';
import { RewardInput } from './reward-token.resolver';
import { MaxChars } from '../../common/validation/max-chars';
import { IsOptionalNotNull } from '../../common/validation/optional-not-null';

const CATEGORIES = ['DEV', 'DESIGN', 'CONTENT', 'OTHER'];
const SUBMISSION_MODES = ['DIRECT', 'AGENT'];
/** bounty_reward.token_type CHECK (0011) */
const TOKEN_TYPES = ['NATIVE', 'CW20', 'ERC20'];
/** 한 바운티의 최대 수상자 수 - 실제 운영 규모(수십 명)보다 넉넉한 상한. 그 위는 오타나 남용이다 */
const MAX_WINNERS_LIMIT = 1000;

/** 보상 입력 — RewardTokenResolver가 읽는 필드만 받는다. USDC는 서버가 env의 컨트랙트/체인으로 덮어쓴다 */
export class RewardDto implements RewardInput {
  @IsIn(TOKEN_TYPES) tokenType!: string;
  // Trim: 공백뿐인 denom/주소가 `!value` 검사(RewardTokenResolver)와 DB NOT NULL 검사를 통과해 지급 불가 보상으로 굳는 것을 막는다
  @IsOptional() @Trim() @IsString() @MaxChars(128) tokenDenom?: string;
  @IsOptional() @Trim() @IsString() @MaxChars(255) tokenContractAddress?: string;
  // BIGINT 컬럼 — JS가 정확히 표현하는 정수까지만 받는다 (그 위는 반올림돼 저장되거나 22003 500)
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) evmChainId?: number;
  @IsString() @Matches(/^[A-Za-z0-9]{1,12}$/) displaySymbol!: string;
  @IsString() @Matches(TOKEN_AMOUNT) amount!: string;
}

export class CreateBountyDto {
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(200) title!: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(100) sponsorName!: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(500) summary!: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(50_000) description!: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(20_000) requirements!: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(20_000) evaluationCriteria!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsBoolean() applicationRequired!: boolean;
  @IsIn(SUBMISSION_MODES) submissionMode!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_WINNERS_LIMIT) maxWinners!: number;
  @IsTimestampString() submissionDeadline!: string;
  @IsOptional() @IsTimestampString() applicationDeadline?: string;
  @IsOptional() @IsHttpUrlOrMediaPath() coverImageUrl?: string;
  @IsOptional() @ValidateNested() @Type(() => RewardDto) reward?: RewardDto;
}

// 수정 요청은 보낸 필드만 검증한다. 다만 필수 텍스트를 빈 값("" 또는 공백)으로 바꾸는 것은 막는다.
// NOT NULL 컬럼에 쓰이는 필드는 null도 400 (IsOptionalNotNull — 예전엔 23502 500). nullable 컬럼(applicationDeadline, coverImageUrl)만 null = 지우기.
// TEXT 컬럼의 상한은 생성의 2배, URL은 완화 규칙(IsSafeUrl) — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로, 엄격 규칙 이전에 저장된 레거시 행이
// 모든 PATCH를 400으로 만들지 않게 한다 (common/validation/url.ts). VARCHAR 컬럼(title 200, sponsor_name 100)은 컬럼 상한 그대로 —
// 완화는 "레거시 모양을 받는다"는 뜻이지 스키마를 넘는다는 뜻이 아니다. MaxChars는 Postgres와 같은 코드 포인트 단위로 센다 (common/validation/max-chars.ts).
export class UpdateBountyDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(200) title?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(100) sponsorName?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(1000) summary?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(100_000) description?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(40_000) requirements?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxLength(40_000) evaluationCriteria?: string;
  @IsOptionalNotNull() @IsIn(CATEGORIES) category?: string;
  @IsOptionalNotNull() @IsBoolean() applicationRequired?: boolean;
  @IsOptionalNotNull() @IsIn(SUBMISSION_MODES) submissionMode?: string;
  @IsOptionalNotNull() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_WINNERS_LIMIT) maxWinners?: number;
  @IsOptionalNotNull() @IsTimestampString() submissionDeadline?: string;
  @IsOptional() @IsTimestampString() applicationDeadline?: string | null;
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
