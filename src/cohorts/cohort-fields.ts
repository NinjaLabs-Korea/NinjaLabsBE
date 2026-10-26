import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';
import { NullIfBlank, Trim } from '../common/validation/trim';
import { ACTIVITY_TYPES, INTEREST_AREAS, OTHER, WEB3_EXPERIENCES } from './cohort-status';

/**
 * 지원서 입력 규칙 (생성/수정 DTO 공용).
 *
 * 연락처는 `@핸들`로 정규화해 저장한다: 사용자가 `@name`, `name`, `https://t.me/name`, `https://x.com/name?s=20` 중 무엇을 넣든 같은 값이 된다.
 * 핸들 모양이 틀리면 정규화된 값이 정규식에 걸려 400(class-validator 메시지)이다.
 *   텔레그램: 영문으로 시작, 영문/숫자/_ 합쳐 5~32자.   트위터(X): 영문/숫자/_ 1~15자.
 */
export const TELEGRAM_HANDLE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const TWITTER_HANDLE = /^@[A-Za-z0-9_]{1,15}$/;

const TELEGRAM_URL = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.*)$/i;
const TWITTER_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(.*)$/i;

/** URL/@ 유무를 정리해 `@handle` 로. 문자열이 아니면 그대로 둔다 (타입 검사는 IsString 몫). 빈 값은 빈 문자열 */
export function normalizeHandle(raw: unknown, urlPattern: RegExp): unknown {
  if (typeof raw !== 'string') return raw;
  let value = raw.trim();
  const url = urlPattern.exec(value);
  if (url) value = url[1].split(/[/?#]/)[0];
  value = value.replace(/^@+/, '');
  return value === '' ? '' : `@${value}`;
}

export const NormalizeTelegram = () => Transform(({ value }: { value: unknown }) => normalizeHandle(value, TELEGRAM_URL));
export const NormalizeTwitter = () => Transform(({ value }: { value: unknown }) => normalizeHandle(value, TWITTER_URL));

/** 배열을 집합으로: 중복 제거(순서 유지). 배열이 아니면 그대로 (IsArray 가 거절) */
const UniqueArray = () => Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? [...new Set(value)] : value));

/** 지원서 입력 필드: 생성 DTO. 컬럼 길이(VARCHAR 60/40, intro 1000)를 그대로 상한으로 쓴다 (MaxChars = Postgres 코드 포인트) */
export class CohortApplicationFields {
  @Trim() @IsString() @IsNotEmpty() @MaxChars(60) displayName!: string;
  @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram!: string;
  @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter!: string;
  @IsIn(WEB3_EXPERIENCES) web3Experience!: string;
  @IsIn(ACTIVITY_TYPES) activityType!: string;
  /** activityType 이 OTHER 일 때만 의미가 있고 그때는 필수 (assertOtherDetails), 아니면 무시하고 NULL 로 저장 */
  @IsOptional() @NullIfBlank() @IsString() @MaxChars(60) activityTypeOther?: string | null;
  @UniqueArray() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(INTEREST_AREAS.length) @IsIn(INTEREST_AREAS, { each: true }) interestAreas!: string[];
  @IsOptional() @NullIfBlank() @IsString() @MaxChars(60) interestOther?: string | null;
  @Trim() @IsString() @IsNotEmpty() @MaxChars(1000) intro!: string;
}

/** 수정: 모두 선택. NOT NULL 컬럼은 null 을 400 으로 막는다 (IsOptionalNotNull), 기타 상세는 nullable */
export class UpdateCohortApplicationDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @MaxChars(60) displayName?: string;
  @IsOptionalNotNull() @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram?: string;
  @IsOptionalNotNull() @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter?: string;
  @IsOptionalNotNull() @IsIn(WEB3_EXPERIENCES) web3Experience?: string;
  @IsOptionalNotNull() @IsIn(ACTIVITY_TYPES) activityType?: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxChars(60) activityTypeOther?: string | null;
  @IsOptionalNotNull() @UniqueArray() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(INTEREST_AREAS.length) @IsIn(INTEREST_AREAS, { each: true }) interestAreas?: string[];
  @IsOptional() @NullIfBlank() @IsString() @MaxChars(60) interestOther?: string | null;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @MaxChars(1000) intro?: string;
}

export type CohortApplicationValues = {
  displayName: string; telegram: string; twitter: string; web3Experience: string;
  activityType: string; activityTypeOther: string | null;
  interestAreas: string[]; interestOther: string | null; intro: string;
};

/**
 * "기타" 상세 규칙: OTHER 이면 상세 필수(없으면 400 COHORT_OTHER_DETAIL_REQUIRED), OTHER 가 아니면 상세는 버린다(NULL).
 * 생성과 수정(기존 행과 합친 값)이 같은 함수를 지나므로 DB CHECK(chk_cohort_application_activity_other / _interest_other)에 닿기 전에 막힌다.
 */
export function normalizeOtherDetails<T extends { activityType: string; activityTypeOther?: string | null; interestAreas: string[]; interestOther?: string | null }>(
  values: T,
): T & { activityTypeOther: string | null; interestOther: string | null } {
  const activityTypeOther = values.activityType === OTHER ? (values.activityTypeOther?.trim() || null) : null;
  const interestOther = values.interestAreas.includes(OTHER) ? (values.interestOther?.trim() || null) : null;
  if (values.activityType === OTHER && !activityTypeOther) throw new BadRequestException('COHORT_OTHER_DETAIL_REQUIRED');
  if (values.interestAreas.includes(OTHER) && !interestOther) throw new BadRequestException('COHORT_OTHER_DETAIL_REQUIRED');
  return { ...values, activityTypeOther, interestOther };
}
