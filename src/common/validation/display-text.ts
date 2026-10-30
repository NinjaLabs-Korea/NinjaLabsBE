import { applyDecorators } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MaxChars } from './max-chars';
import { IsOptionalNotNull } from './optional-not-null';
import { Trim } from './trim';
import { HasNoBidiOverride, HasVisibleText, IsPlainDisplayText, NullIfInvisible } from './visible-text';

/**
 * 운영자가 입력하는 "표시 텍스트" 필드의 검증 체인 단일 출처.
 * QA 라운드마다 규칙을 DTO 속성마다 하나씩 붙여 와서 어긋나기 쉬웠다. 규칙을 더하면 여기 한 곳만 고친다.
 * Trim은 class-transformer 변환이라 ValidationPipe(transform: true)가 검증 전에 적용한다. 검증기들은 항상 다듬어진 값을 본다.
 */

/** 제목류(title, sponsorName): 빈 값, 보이지 않는 글자만, 마크업, bidi 제어문자, 글자 수(코드 포인트) 초과를 거부한다. */
export const DisplayTitle = (max: number) =>
  applyDecorators(Trim(), IsString(), IsNotEmpty(), HasVisibleText(), IsPlainDisplayText(), MaxChars(max));

/** 수정(PATCH)용 제목류: 생략은 통과, null은 400. */
export const OptionalDisplayTitle = (max: number) => applyDecorators(IsOptionalNotNull(), DisplayTitle(max));

/** 본문류(summary, description 등): 마크업은 허용(마크다운), bidi 제어문자만 거부. 길이는 기존과 같이 MaxLength(서로게이트 쌍은 1로 세고 이형 선택자는 뺀다)다. */
export const DisplayBody = (max: number) =>
  applyDecorators(Trim(), IsString(), IsNotEmpty(), HasVisibleText(), HasNoBidiOverride(), MaxLength(max));

/** 수정(PATCH)용 본문류. */
export const OptionalDisplayBody = (max: number) => applyDecorators(IsOptionalNotNull(), DisplayBody(max));

/**
 * 선택 본문류(공지 summary, 심사 note/comment): 생략과 null은 통과, 보이지 않는 글자만 있으면 null로 바꿔 저장한다.
 * 추가 검증(예: 몰수 표식 거부)은 이 데코레이터 뒤에 따로 붙인다.
 */
export const NullableDisplayBody = (max: number) =>
  applyDecorators(IsOptional(), NullIfInvisible(), IsString(), HasNoBidiOverride(), MaxLength(max));
