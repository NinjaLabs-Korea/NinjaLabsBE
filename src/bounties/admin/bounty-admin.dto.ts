import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, Min } from 'class-validator';

const CATEGORIES = ['DEV', 'DESIGN', 'CONTENT', 'OTHER'];
const SUBMISSION_MODES = ['DIRECT', 'AGENT'];

export class CreateBountyDto {
  @IsNotEmpty() title!: string;
  @IsNotEmpty() sponsorName!: string;
  @IsNotEmpty() summary!: string;
  @IsNotEmpty() description!: string;
  @IsNotEmpty() requirements!: string;
  @IsNotEmpty() evaluationCriteria!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsBoolean() applicationRequired!: boolean;
  @IsIn(SUBMISSION_MODES) submissionMode!: string;
  @Type(() => Number) @IsInt() @Min(1) maxWinners!: number;
  @IsNotEmpty() submissionDeadline!: string;
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

export class UpdateBountyDto {
  @IsOptional() title?: string;
  @IsOptional() sponsorName?: string;
  @IsOptional() summary?: string;
  @IsOptional() description?: string;
  @IsOptional() requirements?: string;
  @IsOptional() evaluationCriteria?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsBoolean() applicationRequired?: boolean;
  @IsOptional() @IsIn(SUBMISSION_MODES) submissionMode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxWinners?: number;
  @IsOptional() submissionDeadline?: string;
  @IsOptional() applicationDeadline?: string | null;
  @IsOptional() coverImageUrl?: string | null;
}
