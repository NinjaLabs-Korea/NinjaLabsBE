import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { charLength } from '../common/validation/max-chars';
import { hasNoBidiOverride, hasVisibleText, isPlainDisplayText } from '../common/validation/visible-text';

/**
 * 기수 지원서 질문/답변 모델의 단일 출처 (0021_cohort_questions.sql).
 *
 * 고정 필드(displayName, telegram, twitter, intro)는 컬럼으로 남고, 나머지 질문은 기수마다 운영자가 편집한다 (`cohort.questions` JSONB).
 * 답변은 쓰는 순간의 질문에서 만든 스냅샷이라 질문을 나중에 고쳐도 이미 낸 지원서는 바뀌지 않는다 (`cohort_application.answers`).
 * 옛 고정 컬럼(web3_experience 등)만 채워진 행은 `legacyAnswers`가 읽을 때 답변으로 합성한다.
 * 기본 질문의 id는 옛 컬럼/enum 코드와 같다: 옛 행과 옛 필터가 조회 표 없이 새 모델에 대응한다.
 *
 * 변경이 닿는 곳: supabase/migrations/0021 (기본 질문 마커 블록, cohort-questions.spec.ts가 DEFAULT_COHORT_QUESTIONS와 대조),
 * cohort-fields.ts(입력 DTO), cohort-admin.service.ts(질문 저장), cohort-applications.service.ts(답변 검증·저장),
 * cohort-application-admin.service.ts(필터·CSV), FE src/lib/cohorts.ts(거울).
 */

export type LocalizedText = { ko: string; en: string | null; zh: string | null };
export type LocalizedTextInput = { ko: string; en?: string | null; zh?: string | null };

export const QUESTION_TYPES = ['SHORT_TEXT', 'LONG_TEXT', 'SINGLE_CHOICE', 'MULTI_CHOICE'] as const;
export type CohortQuestionType = (typeof QUESTION_TYPES)[number];

export type CohortQuestionOption = { id: string; label: LocalizedText; withDetail: boolean };
export type CohortQuestion = {
  id: string; type: CohortQuestionType; label: LocalizedText; help: LocalizedText | null; required: boolean; options: CohortQuestionOption[] | null;
};

export type CohortQuestionInput = {
  id?: string; type: CohortQuestionType; label: LocalizedTextInput; help?: LocalizedTextInput | null; required: boolean;
  options?: { id?: string; label: LocalizedTextInput; withDetail?: boolean }[] | null;
};

export type ApplicationAnswer = {
  questionId: string; type: CohortQuestionType; label: LocalizedText; text: string | null;
  choices: { id: string; label: LocalizedText }[] | null; other: string | null;
};
export type AnswerInput = { questionId: string; text?: string; choices?: string[]; other?: string | null };

/** 질문/선택지 id 모양 (서버가 만드는 `q_` + 12 hex, `o_` + 8 hex 포함) */
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export const MAX_QUESTIONS = 30;
export const LABEL_MAX = 200;
export const HELP_MAX = 500;
export const OPTION_LABEL_MAX = 60;
export const OPTION_MIN = 2;
export const OPTION_MAX = 20;
export const SHORT_TEXT_MAX = 200;
export const LONG_TEXT_MAX = 2000;
export const OTHER_MAX = 60;
export const ANSWERS_MAX = 30;

const lt = (ko: string, en: string, zh: string): LocalizedText => ({ ko, en, zh });
const option = (id: string, label: LocalizedText, withDetail = false): CohortQuestionOption => ({ id, label, withDetail });

/** 옛 "관심 분야" 선택지 (옛 활동 유형 선택지에서 STUDENT를 뺀 것 + OTHER) */
const INTEREST_OPTIONS: CohortQuestionOption[] = [
  option('DEVELOPER', lt('개발자', 'Developer', '开发者')),
  option('CONTENT_CREATOR', lt('콘텐츠 크리에이터', 'Content creator', '内容创作者')),
  option('KOL', lt('KOL(인플루언서)', 'KOL (influencer)', 'KOL(意见领袖)')),
  option('COMMUNITY_MARKETING', lt('커뮤니티·마케팅', 'Community & marketing', '社区与营销')),
  option('RESEARCHER', lt('리서처', 'Researcher', '研究员')),
  option('BIZDEV', lt('사업개발', 'Business development', '商务拓展')),
  option('OTHER', lt('기타', 'Other', '其他'), true),
];

const WEB3_QUESTION: CohortQuestion = {
  id: 'web3_experience',
  type: 'SINGLE_CHOICE',
  label: lt('Web3 경력', 'Web3 experience', 'Web3 经验'),
  help: null,
  required: true,
  options: [
    option('LT_1Y', lt('1년 미만', 'Under 1 year', '不足 1 年')),
    option('Y1_3', lt('1~3년', '1-3 years', '1-3 年')),
    option('GT_3Y', lt('3년 이상', 'Over 3 years', '3 年以上')),
  ],
};

const INTEREST_QUESTION: CohortQuestion = {
  id: 'interest_areas',
  type: 'MULTI_CHOICE',
  label: lt('참여하고 싶은 분야', 'Areas you want to join', '想参与的领域'),
  help: lt('해당하는 분야를 모두 골라 주세요.', 'Choose all that apply.', '可多选。'),
  required: true,
  options: INTEREST_OPTIONS,
};

/** 새 기수에 심는 기본 질문. 0021 마이그레이션의 default-questions 마커 블록과 같아야 한다 (cohort-questions.spec.ts가 대조) */
export const DEFAULT_COHORT_QUESTIONS: CohortQuestion[] = [WEB3_QUESTION, INTEREST_QUESTION];

/** 옛 "현재 활동 유형" (새 답변에서는 폐기, 옛 행을 읽을 때만 쓴다). 선택지 표시는 옛 FE recruit.json form.activityType */
export const LEGACY_ACTIVITY_QUESTION: CohortQuestion = {
  id: 'activity_type',
  type: 'SINGLE_CHOICE',
  label: lt('현재 활동 유형', 'Current activity', '当前活动类型'),
  help: null,
  required: true,
  options: [
    ...INTEREST_OPTIONS.filter((o) => o.id !== 'OTHER'),
    option('STUDENT', lt('학생', 'Student', '学生')),
    option('OTHER', lt('기타', 'Other', '其他'), true),
  ],
};

// ───────────────────────── 질문 검증 (운영자 입력) ─────────────────────────

const invalidQuestions = () => new BadRequestException('COHORT_QUESTIONS_INVALID');
const invalidAnswers = () => new BadRequestException('COHORT_ANSWERS_INVALID');

const newId = (prefix: string, bytes: number, taken: Set<string>): string => {
  for (;;) {
    const id = `${prefix}_${randomBytes(bytes).toString('hex')}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
};

/** 한 줄 표시 글: 앞뒤 공백 제거 후 보이는 글자가 있고 제어·방향 제어 문자가 없고 max 코드 포인트 이하 */
function plainLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return hasVisibleText(value) && isPlainDisplayText(value) && charLength(value) <= max ? value : null;
}

/** 여러 줄 설명: 보이는 글자가 있고 방향 재배열 문자가 없고 max 이하 (줄바꿈 허용) */
function multiLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return hasVisibleText(value) && hasNoBidiOverride(value) && charLength(value) <= max ? value : null;
}

const isBlankOrNull = (raw: unknown): boolean => raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

function localized(raw: unknown, max: number, check: (value: unknown, max: number) => string | null): LocalizedText {
  if (typeof raw !== 'object' || raw === null) throw invalidQuestions();
  const input = raw as Record<string, unknown>;
  const ko = check(input.ko, max);
  if (ko === null) throw invalidQuestions();
  const optional = (value: unknown): string | null => {
    if (isBlankOrNull(value)) return null;
    const checked = check(value, max);
    if (checked === null) throw invalidQuestions();
    return checked;
  };
  return { ko, en: optional(input.en), zh: optional(input.zh) };
}

/**
 * 운영자가 보낸 질문 목록을 저장할 목록으로 정규화한다. 저장된 목록(stored)은 id 재사용 검사 기준이다:
 * 보낸 id는 stored에 있어야 하고(질문 id, 그 질문의 선택지 id), id가 없으면 새 항목으로 서버가 id를 만든다.
 * 규칙을 어기면 400 COHORT_QUESTIONS_INVALID.
 */
export function validateQuestions(stored: readonly CohortQuestion[], input: readonly CohortQuestionInput[]): CohortQuestion[] {
  if (!Array.isArray(input) || input.length > MAX_QUESTIONS) throw invalidQuestions();
  const storedById = new Map(stored.map((q) => [q.id, q]));
  const taken = new Set<string>(input.map((q) => q?.id).filter((id): id is string => typeof id === 'string'));
  if (taken.size !== input.filter((q) => q?.id !== undefined && q?.id !== null).length) throw invalidQuestions(); // 중복 id
  const seenQuestionIds = new Set<string>();

  return input.map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw invalidQuestions();
    if (!QUESTION_TYPES.includes(raw.type)) throw invalidQuestions();
    if (typeof raw.required !== 'boolean') throw invalidQuestions();
    let existing: CohortQuestion | undefined;
    let id: string;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || !QUESTION_ID_PATTERN.test(raw.id)) throw invalidQuestions();
      existing = storedById.get(raw.id);
      if (!existing || seenQuestionIds.has(raw.id)) throw invalidQuestions();
      id = raw.id;
    } else {
      id = newId('q', 6, taken);
    }
    seenQuestionIds.add(id);

    const label = localized(raw.label, LABEL_MAX, plainLine);
    const help = raw.help === undefined || raw.help === null ? null : localized(raw.help, HELP_MAX, multiLine);

    let options: CohortQuestionOption[] | null = null;
    if (raw.type === 'SINGLE_CHOICE' || raw.type === 'MULTI_CHOICE') {
      const list = raw.options;
      if (!Array.isArray(list) || list.length < OPTION_MIN || list.length > OPTION_MAX) throw invalidQuestions();
      const storedOptions = new Map((existing?.options ?? []).map((o) => [o.id, o]));
      const optionIds = new Set<string>(list.map((o) => o?.id).filter((x): x is string => typeof x === 'string'));
      if (optionIds.size !== list.filter((o) => o?.id !== undefined && o?.id !== null).length) throw invalidQuestions();
      const seenOptionIds = new Set<string>();
      options = list.map((o) => {
        if (typeof o !== 'object' || o === null) throw invalidQuestions();
        let optionId: string;
        if (o.id !== undefined && o.id !== null) {
          if (typeof o.id !== 'string' || !QUESTION_ID_PATTERN.test(o.id) || !storedOptions.has(o.id) || seenOptionIds.has(o.id)) throw invalidQuestions();
          optionId = o.id;
        } else {
          optionId = newId('o', 4, optionIds);
        }
        seenOptionIds.add(optionId);
        if (o.withDetail !== undefined && typeof o.withDetail !== 'boolean') throw invalidQuestions();
        return { id: optionId, label: localized(o.label, OPTION_LABEL_MAX, plainLine), withDetail: o.withDetail === true };
      });
      if (options.filter((o) => o.withDetail).length > 1) throw invalidQuestions();
    } else if (raw.options !== undefined && raw.options !== null) {
      throw invalidQuestions();
    }
    return { id, type: raw.type, label, help, required: raw.required, options };
  });
}

// ───────────────────────── 답변 검증 (지원자 입력) ─────────────────────────

/**
 * 지원자의 답변을 현재 질문 기준으로 검증하고 저장할 스냅샷으로 만든다 (질문 순서, 답하지 않은 선택 질문은 생략).
 * 규칙을 어기면 400 COHORT_ANSWERS_INVALID, 상세 입력(withDetail) 선택지를 골랐는데 other가 비면 400 COHORT_OTHER_DETAIL_REQUIRED.
 * FE src/lib/cohorts.ts가 같은 규칙을 거울로 가진다.
 */
export function validateAnswers(questions: readonly CohortQuestion[], input: readonly AnswerInput[]): ApplicationAnswer[] {
  if (!Array.isArray(input) || input.length > ANSWERS_MAX) throw invalidAnswers();
  const byQuestion = new Map<string, AnswerInput>();
  for (const answer of input) {
    if (typeof answer !== 'object' || answer === null || typeof answer.questionId !== 'string') throw invalidAnswers();
    if (byQuestion.has(answer.questionId)) throw invalidAnswers();
    byQuestion.set(answer.questionId, answer);
  }
  const known = new Set(questions.map((q) => q.id));
  for (const id of byQuestion.keys()) if (!known.has(id)) throw invalidAnswers();

  const snapshot: ApplicationAnswer[] = [];
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    const built = answer ? buildAnswer(question, answer) : null;
    if (!built) {
      if (question.required) throw invalidAnswers();
      continue;
    }
    snapshot.push(built);
  }
  return snapshot;
}

/** 질문 하나의 답변. 답하지 않은 것이면 null (필수 여부는 호출한 쪽) */
function buildAnswer(question: CohortQuestion, answer: AnswerInput): ApplicationAnswer | null {
  const hasChoices = Array.isArray(answer.choices) && answer.choices.length > 0;
  const hasText = typeof answer.text === 'string' && answer.text.trim() !== '';
  if (answer.text !== undefined && typeof answer.text !== 'string') throw invalidAnswers();
  if (answer.choices !== undefined && !Array.isArray(answer.choices)) throw invalidAnswers();
  if (answer.other !== undefined && answer.other !== null && typeof answer.other !== 'string') throw invalidAnswers();

  if (question.type === 'SHORT_TEXT' || question.type === 'LONG_TEXT') {
    if (hasChoices || !isBlankOrNull(answer.other)) throw invalidAnswers();
    if (!hasText || !hasVisibleText(answer.text)) return null;
    const text = (answer.text as string).trim();
    const ok = question.type === 'SHORT_TEXT' ? plainLine(text, SHORT_TEXT_MAX) : multiLine(text, LONG_TEXT_MAX);
    if (ok === null) throw invalidAnswers();
    return { questionId: question.id, type: question.type, label: question.label, text: ok, choices: null, other: null };
  }

  if (hasText) throw invalidAnswers();
  if (!hasChoices) return null;
  const ids = answer.choices as unknown[];
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw invalidAnswers();
  if (question.type === 'SINGLE_CHOICE' && ids.length !== 1) throw invalidAnswers();
  const options = question.options ?? [];
  const chosen = ids.map((id) => options.find((o) => o.id === id));
  if (chosen.some((o) => !o)) throw invalidAnswers();
  const picked = chosen as CohortQuestionOption[];
  // 저장 순서는 질문의 선택지 순서
  const ordered = options.filter((o) => picked.includes(o));

  let other: string | null = null;
  if (ordered.some((o) => o.withDetail)) {
    other = typeof answer.other === 'string' ? plainLine(answer.other, OTHER_MAX) : null;
    if (other === null) throw new BadRequestException('COHORT_OTHER_DETAIL_REQUIRED');
  }
  return {
    questionId: question.id, type: question.type, label: question.label, text: null,
    choices: ordered.map((o) => ({ id: o.id, label: o.label })), other,
  };
}

// ───────────────────────── 옛 행 읽기 ─────────────────────────

export type AnswerSourceRow = {
  answers: ApplicationAnswer[] | null;
  web3_experience: string | null;
  activity_type: string | null;
  activity_type_other: string | null;
  interest_areas: string[] | null;
  interest_other: string | null;
};

function snapshotOf(question: CohortQuestion, chosenIds: string[], other: string | null): ApplicationAnswer {
  const options = question.options ?? [];
  return {
    questionId: question.id, type: question.type, label: question.label, text: null,
    choices: options.filter((o) => chosenIds.includes(o.id)).map((o) => ({ id: o.id, label: o.label })), other,
  };
}

/**
 * 지원서 행의 답변: 저장된 스냅샷이 있으면 그대로, 옛 행(answers 비어 있고 옛 컬럼이 찼음)이면 합성한다
 * (web3_experience, interest_areas, activity_type 순). 지원자 응답, 운영자 응답, CSV가 모두 이 함수를 쓴다.
 */
export function legacyAnswers(row: AnswerSourceRow): ApplicationAnswer[] {
  if (row.answers && row.answers.length > 0) return row.answers;
  if (row.web3_experience === null || row.web3_experience === undefined) return [];
  return [
    snapshotOf(WEB3_QUESTION, [row.web3_experience], null),
    snapshotOf(INTEREST_QUESTION, row.interest_areas ?? [], row.interest_other),
    snapshotOf(LEGACY_ACTIVITY_QUESTION, row.activity_type ? [row.activity_type] : [], row.activity_type_other),
  ];
}

// ───────────────────────── CSV ─────────────────────────

/**
 * 답변 한 칸의 CSV 값: 글 답변은 text, 선택 답변은 선택지 label.ko를 ';'로 연결.
 * 상세 입력(withDetail) 선택지는 `label (other)`로 쓴다. 어느 선택지가 상세 입력인지는 현재 질문(question)에서 찾고,
 * 현재 질문에 없으면 id가 OTHER인 선택지, 그것도 없으면 마지막 선택지로 본다 (상세는 그 선택지를 골랐을 때만 있다).
 */
export function answerCsvValue(answer: ApplicationAnswer, question?: CohortQuestion): string {
  if (answer.choices === null) return answer.text ?? '';
  const detailIds = new Set((question?.options ?? []).filter((o) => o.withDetail).map((o) => o.id));
  const detailChoice = answer.other === null
    ? undefined
    : (answer.choices.find((c) => detailIds.has(c.id)) ?? answer.choices.find((c) => c.id === 'OTHER') ?? answer.choices[answer.choices.length - 1]);
  return answer.choices.map((c) => (c === detailChoice ? `${c.label.ko} (${answer.other})` : c.label.ko)).join(';');
}

/** CSV 한 행의 질문별 칸(현재 질문 순서)과 other_answers(현재 질문에 없는 답변, 줄바꿈으로 연결) */
export function answerCsvCells(questions: readonly CohortQuestion[], answers: readonly ApplicationAnswer[]): { cells: string[]; otherAnswers: string } {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const current = new Set(questions.map((q) => q.id));
  return {
    cells: questions.map((q) => {
      const a = byId.get(q.id);
      return a ? answerCsvValue(a, q) : '';
    }),
    otherAnswers: answers.filter((a) => !current.has(a.questionId)).map((a) => `${a.label.ko}: ${answerCsvValue(a)}`).join('\n'),
  };
}
