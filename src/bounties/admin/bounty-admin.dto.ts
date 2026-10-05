import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, Min } from 'class-validator';
import { Trim } from '../../common/validation/trim';

const CATEGORIES = ['DEV', 'DESIGN', 'CONTENT', 'OTHER'];
const SUBMISSION_MODES = ['DIRECT', 'AGENT'];

export class CreateBountyDto {
  @Trim() @IsNotEmpty() title!: string;
  @Trim() @IsNotEmpty() sponsorName!: string;
  @Trim() @IsNotEmpty() summary!: string;
  @Trim() @IsNotEmpty() description!: string;
  @Trim() @IsNotEmpty() requirements!: string;
  @Trim() @IsNotEmpty() evaluationCriteria!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsBoolean() applicationRequired!: boolean;
  @IsIn(SUBMISSION_MODES) submissionMode!: string;
  @Type(() => Number) @IsInt() @Min(1) maxWinners!: number;
  @IsDateString() submissionDeadline!: string;
  @IsOptional() applicationDeadline?: string;
  @IsOptional() coverImageUrl?: string;
  @IsOptional() reward?: {
    tokenType: string;
    tokenDenom?: string;
    tokenContractAddress?: string;
    evmChainId?: number;
    displaySymbol: string;
    amount: string;
  };
}

// 수정 요청은 보낸 필드만 검증한다. 다만 필수 텍스트를 빈 값("" 또는 공백)으로 바꾸는 것은 막는다.
export class UpdateBountyDto {
  @IsOptional() @Trim() @IsNotEmpty() title?: string;
  @IsOptional() @Trim() @IsNotEmpty() sponsorName?: string;
  @IsOptional() @Trim() @IsNotEmpty() summary?: string;
  @IsOptional() @Trim() @IsNotEmpty() description?: string;
  @IsOptional() @Trim() @IsNotEmpty() requirements?: string;
  @IsOptional() @Trim() @IsNotEmpty() evaluationCriteria?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsBoolean() applicationRequired?: boolean;
  @IsOptional() @IsIn(SUBMISSION_MODES) submissionMode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxWinners?: number;
  @IsOptional() @IsDateString() submissionDeadline?: string;
  @IsOptional() applicationDeadline?: string | null;
  @IsOptional() coverImageUrl?: string | null;
}
