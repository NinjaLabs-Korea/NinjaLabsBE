import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';
import { IsTimestampString } from '../common/validation/timestamp';
import { NullIfBlank, Trim } from '../common/validation/trim';
import { QUESTION_ID_PATTERN, QUESTION_TYPES } from './cohort-questions';
import { ACTIVITY_TYPES, CohortApplicationPolicy, CohortStatusPolicy, INTEREST_AREAS } from './cohort-status';

/** 운영자 기수 API(cohort-admin.controller.ts)의 요청 DTO. 검증 규칙은 그대로 옮겼다 */

export class CreateCohortDto {
  @Trim() @IsString() @IsNotEmpty() @MaxChars(60) name!: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(10_000) description?: string | null;
  @IsOptional() @IsTimestampString() opensAt?: string | null;
  @IsOptional() @IsTimestampString() closesAt?: string | null;
}

export class UpdateCohortDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @MaxChars(60) name?: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(10_000) description?: string | null;
  @IsOptional() @IsTimestampString() opensAt?: string | null;
  @IsOptional() @IsTimestampString() closesAt?: string | null;
}

export class TransitionCohortDto {
  @IsIn(CohortStatusPolicy.transitionTargets()) to!: string;
}

/**
 * 질문 편집 본문 (모양만 본다). 길이·글자 규칙, id 존재, 선택지 수, withDetail 개수 같은 내용 규칙은
 * cohort-questions.ts validateQuestions 가 400 COHORT_QUESTIONS_INVALID 로 거절한다 (모양이 틀리면 400 VALIDATION_FAILED).
 * 문자열 상한은 페이로드 크기 방어용으로 넉넉히 둔다.
 */
export class LocalizedTextInputDto {
  @IsString() @MaxLength(2000) ko!: string;
  @IsOptional() @IsString() @MaxLength(2000) en?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) zh?: string | null;
}

export class CohortQuestionOptionInputDto {
  @IsOptional() @IsString() @Matches(QUESTION_ID_PATTERN) id?: string;
  @ValidateNested() @Type(() => LocalizedTextInputDto) label!: LocalizedTextInputDto;
  @IsOptional() @IsBoolean() withDetail?: boolean;
}

export class CohortQuestionInputDto {
  @IsOptional() @IsString() @Matches(QUESTION_ID_PATTERN) id?: string;
  @IsIn(QUESTION_TYPES) type!: (typeof QUESTION_TYPES)[number];
  @ValidateNested() @Type(() => LocalizedTextInputDto) label!: LocalizedTextInputDto;
  @IsOptional() @ValidateNested() @Type(() => LocalizedTextInputDto) help?: LocalizedTextInputDto | null;
  @IsBoolean() required!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CohortQuestionOptionInputDto) options?: CohortQuestionOptionInputDto[] | null;
}

export class CohortQuestionsDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CohortQuestionInputDto) questions!: CohortQuestionInputDto[];
}

export class ListCohortApplicationsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(CohortApplicationPolicy.all()) status?: string;
  /** questionId + optionId: 둘 다 있을 때만 필터가 된다 (답변에서 그 선택지를 고른 지원서) */
  @IsOptional() @IsString() @Matches(QUESTION_ID_PATTERN) questionId?: string;
  @IsOptional() @IsString() @Matches(QUESTION_ID_PATTERN) optionId?: string;
  /** 옛 운영 화면용 별칭: activityType=X == questionId=activity_type&optionId=X */
  @IsOptional() @IsIn(ACTIVITY_TYPES) activityType?: string;
  /** 옛 운영 화면용 별칭: interestArea=X == questionId=interest_areas&optionId=X */
  @IsOptional() @IsIn(INTEREST_AREAS) interestArea?: string;
  /** 이름·텔레그램·트위터·닉네임·이메일 부분 일치. 이메일(320)보다 긴 검색어는 어떤 행과도 맞지 않는다 */
  @IsOptional() @Trim() @IsString() @MaxChars(320) q?: string;
}

export class ReviewCohortApplicationDto {
  @IsIn(CohortApplicationPolicy.reviewDecisions()) decision!: 'ACCEPTED' | 'REJECTED';
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(2000) note?: string | null;
}
