import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';
import { Trim } from '../common/validation/trim';
import { HasNoBidiOverride, HasVisibleText, IsPlainDisplayText } from '../common/validation/visible-text';
import { ANSWERS_MAX, LONG_TEXT_MAX, OPTION_MAX, OTHER_MAX, QUESTION_ID_PATTERN } from './cohort-questions';

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
 *
 * 옛 본문(web3Experience, activityType, activityTypeOther, interestAreas, interestOther)은 더는 받지 않는다 (FE 릴리스 #69 뒤 제거).
 * DTO에 없는 필드라 forbidNonWhitelisted 가 400(DTO 검증 실패, "property web3Experience should not exist")으로 거절한다.
 * 옛 형식으로 저장된 행은 그대로 두고 읽을 때만 합성한다 (cohort-questions.ts legacyAnswers).
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

/** 지원서 입력 필드: 생성 DTO. 컬럼 길이(VARCHAR 60/40, intro 1000)를 그대로 상한으로 쓴다 (MaxChars = Postgres 코드 포인트) */
export class CohortApplicationFields {
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(60) displayName!: string;
  @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram!: string;
  @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter!: string;
  /** 기수 질문에 대한 답변 (최대 30개, 필수: 질문이 없거나 모두 선택이면 빈 배열). 빠지거나 null 이면 400 DTO 검증 실패 */
  @IsArray() @ArrayMaxSize(ANSWERS_MAX) @ValidateNested({ each: true }) @Type(() => AnswerInputDto) answers!: AnswerInputDto[];
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxChars(1000) intro!: string;
}

/** 수정: 모두 선택. null 은 400 으로 막는다 (IsOptionalNotNull). 옛 필드는 생성과 같이 400 */
export class UpdateCohortApplicationDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @IsPlainDisplayText() @MaxChars(60) displayName?: string;
  @IsOptionalNotNull() @NormalizeTelegram() @IsString() @Matches(TELEGRAM_HANDLE, { message: 'telegram must be a valid Telegram username (5-32 letters, digits or _)' }) telegram?: string;
  @IsOptionalNotNull() @NormalizeTwitter() @IsString() @Matches(TWITTER_HANDLE, { message: 'twitter must be a valid X (Twitter) username (1-15 letters, digits or _)' }) twitter?: string;
  /** 보내면 전체 교체: 지금 질문 기준으로 검증한다. 안 보내면 저장된 답변을 그대로 둔다 */
  @IsOptionalNotNull() @IsArray() @ArrayMaxSize(ANSWERS_MAX) @ValidateNested({ each: true }) @Type(() => AnswerInputDto) answers?: AnswerInputDto[];
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @HasNoBidiOverride() @MaxChars(1000) intro?: string;
}
