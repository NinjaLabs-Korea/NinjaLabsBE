import { BadRequestException } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';
import { NullIfBlank, Trim } from '../common/validation/trim';
import { HasNoBidiOverride, HasVisibleText, IsPlainDisplayText, NullIfInvisible, hasVisibleText } from '../common/validation/visible-text';
import { ANSWERS_MAX, LONG_TEXT_MAX, OPTION_MAX, OTHER_MAX, QUESTION_ID_PATTERN } from './cohort-questions';
import { ACTIVITY_TYPES, INTEREST_AREAS, OTHER, WEB3_EXPERIENCES } from './cohort-status';

/**
 * 지원서 입력 규칙 (생성/수정 DTO 공용).
 *
 * 연락처는 `@핸들`로 정규화해 저장한다: 사용자가 `@name`, `name`, `https://t.me/name`, `https://x.com/name?s=20` 중 무엇을 넣든 같은 값이 된다.
 * 핸들 모양이 틀리면 정규화된 값이 정규식에 걸려 400(class-validator 메시지)이다.
 *   텔레그램: 영문으로 시작, 영문/숫자/_ 합쳐 5~32자.   트위터(X): 영문/숫자/_ 1~15자.
 * 프로필 링크가 아닌 URL은 핸들로 바꾸지 않고 원문 그대로 둬서 같은 400이 난다: 초대/공유/게시물 링크
 * (`t.me/joinchat/..`는 `@joinchat`이 아니다, `t.me/채널/123`은 게시물, `x.com/i/..`, `x.com/intent/..`)는 남의 핸들로 둔갑하면 안 된다.
 *
 * 텍스트 규칙 (생성/수정 DTO 공용, `common/validation/visible-text.ts`):
 *   displayName: 보이는 글자 필수, 줄바꿈·제어·방향 제어·제로폭 문자 거부 (ZWJ/ZWNJ는 허용: 이모지, 한글 외 문자).
 *   intro: 보이는 글자 필수, 방향 임베딩/오버라이드(RLO 등) 거부, 줄바꿈은 허용.
 *   answers: 기수 질문(cohort.questions)에 대한 답변. 모양만 여기서 보고(AnswerInputDto), 질문과 맞는지는 cohort-questions.ts validateAnswers 가 본다.
 *   옛 필드(web3Experience, activityType, activityTypeOther, interestAreas, interestOther)는 deprecated: 옛 FE 본문 호환용으로 남겨 두며 FE-1 배포 뒤 정리에서 지운다.
 *   activityTypeOther / interestOther: 한 줄 표시용이라 displayName과 같은 문자 거부, 보이는 글자가 없으면 빈 값으로 보고
 *   "기타" 선택 시 COHORT_OTHER_DETAIL_REQUIRED.
 */
export const TELEGRAM_HANDLE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const TWITTER_HANDLE = /^@[A-Za-z0-9_]{1,15}$/;

const TELEGRAM_URL = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.*)$/i;
const TWITTER_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(.*)$/i;

/** 프로필이 아닌 서비스 경로: 첫 세그먼트가 이 중 하나면 핸들이 아니다 (패턴별) */
const RESERVED_PATHS = new Map<string, ReadonlySet<string>>([
  [TELEGRAM_URL.source, new Set(['joinchat', 'share', 'addstickers', 'addemoji', 'addtheme', 'addlist', 'proxy', 'socks', 'c', 's', 'iv', 'login', 'setlanguage', 'confirmphone', 'invoice', 'boost', 'm', 'msg', 'msg_url'])],
  [TWITTER_URL.source, new Set(['i', 'intent', 'home', 'share', 'search', 'hashtag'])],
]);

/**
 * URL/@ 유무를 정리해 `@handle` 로. 문자열이 아니면 그대로 둔다 (타입 검사는 IsString 몫). 빈 값은 빈 문자열.
 * 예약 경로이거나 경로 세그먼트가 둘 이상인 URL(게시물/초대 링크)은 원문을 그대로 돌려줘서 핸들 검사에서 400이 나게 한다.
 */
export function normalizeHandle(raw: unknown, urlPattern: RegExp): unknown {
  if (typeof raw !== 'string') return raw;
  let value = raw.trim();
  const url = urlPattern.exec(value);
  if (url) {
    const segments = url[1].split(/[?#]/)[0].split('/').filter((segment) => segment !== '');
    const reserved = RESERVED_PATHS.get(urlPattern.source);
    if (segments.length > 1 || (segments.length === 1 && reserved?.has(segments[0].toLowerCase()))) return value;
    value = segments[0] ?? '';
  }
  value = value.replace(/^@+/, '');
  return value === '' ? '' : `@${value}`;
}

export const NormalizeTelegram = () => Transform(({ value }: { value: unknown }) => normalizeHandle(value, TELEGRAM_URL));
export const NormalizeTwitter = () => Transform(({ value }: { value: unknown }) => normalizeHandle(value, TWITTER_URL));

/** 질문 하나에 대한 답변 입력 (모양만). 글 답변은 text, 선택 답변은 choices(+ 상세 입력 other) */
export class AnswerInputDto {
  @IsString() @Matches(QUESTION_ID_PATTERN) questionId!: string;
  @IsOptional() @IsString() @MaxChars(LONG_TEXT_MAX) text?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(OPTION_MAX) @ArrayUnique() @IsString({ each: true }) @Matches(QUESTION_ID_PATTERN, { each: true }) choices?: string[];
  @IsOptional() @IsString() @MaxChars(OTHER_MAX) other?: string | null;
}

/** 배열을 집합으로: 중복 제거(순서 유지). 배열이 아니면 그대로 (IsArray 가 거절) */
const UniqueArray = () => Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? [...new Set(value)] : value));

/** 지원서 입력 필드: 생성 DTO. 컬럼 길이(VARCHAR 60/40, intro 1000)를 그대로 상한으로 쓴다 (MaxChars = Postgres 코드 포인트) */
export class CohortApplicationFields {
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(60) displayName!: string;
  @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram!: string;
  @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter!: string;
  /** 새 본문: 기수 질문에 대한 답변 (최대 30개). 옛 필드와 함께 보내면 400 COHORT_ANSWERS_INVALID */
  @IsOptionalNotNull() @IsArray() @ArrayMaxSize(ANSWERS_MAX) @ValidateNested({ each: true }) @Type(() => AnswerInputDto) answers?: AnswerInputDto[];
  /** @deprecated 옛 FE 본문. answers 가 없을 때만 받고 셋(web3Experience, activityType, interestAreas)이 모두 있어야 한다 */
  @IsOptionalNotNull() @IsIn(WEB3_EXPERIENCES) web3Experience?: string;
  /** @deprecated */
  @IsOptionalNotNull() @IsIn(ACTIVITY_TYPES) activityType?: string;
  /** @deprecated activityType 이 OTHER 일 때만 의미가 있고 그때는 필수 (normalizeOtherDetails), 아니면 무시하고 NULL 로 저장 */
  @IsOptional() @NullIfBlank() @NullIfInvisible() @IsString() @IsPlainDisplayText() @MaxChars(60) activityTypeOther?: string | null;
  /** @deprecated */
  @IsOptionalNotNull() @UniqueArray() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(INTEREST_AREAS.length) @IsIn(INTEREST_AREAS, { each: true }) interestAreas?: string[];
  /** @deprecated */
  @IsOptional() @NullIfBlank() @NullIfInvisible() @IsString() @IsPlainDisplayText() @MaxChars(60) interestOther?: string | null;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxChars(1000) intro!: string;
}

/** 수정: 모두 선택. NOT NULL 컬럼은 null 을 400 으로 막는다 (IsOptionalNotNull), 기타 상세는 nullable */
export class UpdateCohortApplicationDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(60) displayName?: string;
  @IsOptionalNotNull() @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram?: string;
  @IsOptionalNotNull() @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter?: string;
  /** 보내면 전체 교체: 지금 질문 기준으로 검증한다. 안 보내면 저장된 답변을 그대로 둔다 */
  @IsOptionalNotNull() @IsArray() @ArrayMaxSize(ANSWERS_MAX) @ValidateNested({ each: true }) @Type(() => AnswerInputDto) answers?: AnswerInputDto[];
  /** @deprecated 옛 FE 본문 (옛 형식 행에만 통한다) */
  @IsOptionalNotNull() @IsIn(WEB3_EXPERIENCES) web3Experience?: string;
  /** @deprecated */
  @IsOptionalNotNull() @IsIn(ACTIVITY_TYPES) activityType?: string;
  /** @deprecated */
  @IsOptional() @NullIfBlank() @NullIfInvisible() @IsString() @IsPlainDisplayText() @MaxChars(60) activityTypeOther?: string | null;
  /** @deprecated */
  @IsOptionalNotNull() @UniqueArray() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(INTEREST_AREAS.length) @IsIn(INTEREST_AREAS, { each: true }) interestAreas?: string[];
  /** @deprecated */
  @IsOptional() @NullIfBlank() @NullIfInvisible() @IsString() @IsPlainDisplayText() @MaxChars(60) interestOther?: string | null;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxChars(1000) intro?: string;
}

/** 옛 형식 필드 묶음 (deprecated 본문과 옛 형식 행) */
export type LegacyAnswerValues = {
  web3Experience: string; activityType: string; activityTypeOther: string | null; interestAreas: string[]; interestOther: string | null;
};
export type CohortApplicationValues = { displayName: string; telegram: string; twitter: string; intro: string } & LegacyAnswerValues;

/** 본문에 옛 형식 필드가 하나라도 있나 (null 도 "보냈다"로 센다: 섞어 보낸 것을 잡는다) */
export const LEGACY_FIELD_KEYS = ['web3Experience', 'activityType', 'activityTypeOther', 'interestAreas', 'interestOther'] as const;
export function hasLegacyFields(body: object): boolean {
  return LEGACY_FIELD_KEYS.some((key) => (body as Record<string, unknown>)[key] !== undefined);
}

const visibleOrNull = (value?: string | null) => (hasVisibleText(value) ? (value as string).trim() : null);

/**
 * "기타" 상세 규칙: OTHER 이면 상세 필수(없으면 400 COHORT_OTHER_DETAIL_REQUIRED), OTHER 가 아니면 상세는 버린다(NULL).
 * 생성과 수정(기존 행과 합친 값)이 같은 함수를 지나므로 DB CHECK(chk_cohort_application_activity_other / _interest_other)에 닿기 전에 막힌다.
 */
export function normalizeOtherDetails<T extends { activityType: string; activityTypeOther?: string | null; interestAreas: string[]; interestOther?: string | null }>(
  values: T,
): T & { activityTypeOther: string | null; interestOther: string | null } {
  const activityTypeOther = values.activityType === OTHER ? (visibleOrNull(values.activityTypeOther)) : null;
  const interestOther = values.interestAreas.includes(OTHER) ? (visibleOrNull(values.interestOther)) : null;
  if (values.activityType === OTHER && !activityTypeOther) throw new BadRequestException('COHORT_OTHER_DETAIL_REQUIRED');
  if (values.interestAreas.includes(OTHER) && !interestOther) throw new BadRequestException('COHORT_OTHER_DETAIL_REQUIRED');
  return { ...values, activityTypeOther, interestOther };
}
