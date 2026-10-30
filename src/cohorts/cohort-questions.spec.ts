import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ApplicationAnswer, CohortQuestion, CohortQuestionInput, DEFAULT_COHORT_QUESTIONS, LEGACY_ACTIVITY_QUESTION, QUESTION_ID_PATTERN,
  answerCsvCells, legacyAnswers, validateAnswers, validateQuestions,
} from './cohort-questions';

const MIGRATION = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0021_cohort_questions.sql'), 'utf8');

const lt = (ko: string) => ({ ko });
const choice = (overrides: Partial<CohortQuestionInput> = {}): CohortQuestionInput => ({
  type: 'SINGLE_CHOICE', label: lt('질문'), required: true,
  options: [{ label: lt('가') }, { label: lt('나') }], ...overrides,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (err) { return (err as Error).message; }
  return null;
};

describe('0021 default questions', () => {
  it('the marker block parses and deep-equals DEFAULT_COHORT_QUESTIONS', () => {
    const block = /-- default-questions:begin\n([\s\S]*?)-- default-questions:end/.exec(MIGRATION)![1];
    const json = /questions = '(\[.*\])'::jsonb WHERE/.exec(block)![1];
    expect(JSON.parse(json)).toEqual(DEFAULT_COHORT_QUESTIONS);
  });

  it('uses the old column names / enum codes as ids and passes its own validation', () => {
    expect(DEFAULT_COHORT_QUESTIONS.map((q) => q.id)).toEqual(['web3_experience', 'interest_areas']);
    expect(DEFAULT_COHORT_QUESTIONS[1].options!.map((o) => o.id)).toEqual(['DEVELOPER', 'CONTENT_CREATOR', 'KOL', 'COMMUNITY_MARKETING', 'RESEARCHER', 'BIZDEV', 'OTHER']);
    expect(DEFAULT_COHORT_QUESTIONS[1].options!.filter((o) => o.withDetail).map((o) => o.id)).toEqual(['OTHER']);
    expect(() => validateQuestions(DEFAULT_COHORT_QUESTIONS, JSON.parse(JSON.stringify(DEFAULT_COHORT_QUESTIONS)))).not.toThrow();
  });
});

describe('validateQuestions', () => {
  it('assigns generated ids to new questions and options (q_ + 12 hex, o_ + 8 hex) and keeps stored ids', () => {
    const [kept, created] = validateQuestions(DEFAULT_COHORT_QUESTIONS, [
      { ...(DEFAULT_COHORT_QUESTIONS[0] as CohortQuestionInput) },
      choice(),
    ]);
    expect(kept.id).toBe('web3_experience');
    expect(created.id).toMatch(/^q_[0-9a-f]{12}$/);
    expect(created.options!.map((o) => o.id)).toEqual([expect.stringMatching(/^o_[0-9a-f]{8}$/), expect.stringMatching(/^o_[0-9a-f]{8}$/)]);
    expect(created.id).toMatch(QUESTION_ID_PATTERN);
    expect(created).toMatchObject({ help: null, label: { ko: '질문', en: null, zh: null }, options: [{ withDetail: false }, { withDetail: false }] });
  });

  it('trims text, turns blank en/zh into null and normalizes help', () => {
    const [q] = validateQuestions([], [choice({ label: { ko: ' 질문 ', en: '  ', zh: ' 问题 ' }, help: { ko: '한 줄\n두 줄', en: null } })]);
    expect(q.label).toEqual({ ko: '질문', en: null, zh: '问题' });
    expect(q.help).toEqual({ ko: '한 줄\n두 줄', en: null, zh: null });
  });

  it('text questions take no options', () => {
    expect(validateQuestions([], [{ type: 'SHORT_TEXT', label: lt('이름'), required: false }])[0].options).toBeNull();
    expect(code(() => validateQuestions([], [{ type: 'LONG_TEXT', label: lt('x'), required: true, options: [{ label: lt('a') }, { label: lt('b') }] }]))).toBe('COHORT_QUESTIONS_INVALID');
  });

  it.each([
    ['unknown question id', () => validateQuestions(DEFAULT_COHORT_QUESTIONS, [choice({ id: 'nope' })])],
    ['unknown option id', () => validateQuestions(DEFAULT_COHORT_QUESTIONS, [choice({ id: 'web3_experience', options: [{ id: 'ghost', label: lt('a') }, { label: lt('b') }] })])],
    ['option id on a new question', () => validateQuestions([], [choice({ options: [{ id: 'LT_1Y', label: lt('a') }, { label: lt('b') }] })])],
    ['duplicate question ids', () => validateQuestions(DEFAULT_COHORT_QUESTIONS, [choice({ id: 'web3_experience' }), choice({ id: 'web3_experience' })])],
    ['duplicate option ids', () => validateQuestions(DEFAULT_COHORT_QUESTIONS, [choice({ id: 'web3_experience', options: [{ id: 'LT_1Y', label: lt('a') }, { id: 'LT_1Y', label: lt('b') }] })])],
    ['1 option', () => validateQuestions([], [choice({ options: [{ label: lt('a') }] })])],
    ['21 options', () => validateQuestions([], [choice({ options: Array.from({ length: 21 }, (_, i) => ({ label: lt(`o${i}`) })) })])],
    ['two withDetail options', () => validateQuestions([], [choice({ options: [{ label: lt('a'), withDetail: true }, { label: lt('b'), withDetail: true }] })])],
    ['blank label.ko', () => validateQuestions([], [choice({ label: lt('   ') })])],
    ['201 character label.ko', () => validateQuestions([], [choice({ label: lt('가'.repeat(201)) })])],
    ['newline in label', () => validateQuestions([], [choice({ label: lt('a\nb') })])],
    ['201 character label.en', () => validateQuestions([], [choice({ label: { ko: 'ok', en: 'x'.repeat(201) } })])],
    ['61 character option label', () => validateQuestions([], [choice({ options: [{ label: lt('가'.repeat(61)) }, { label: lt('b') }] })])],
    ['501 character help', () => validateQuestions([], [choice({ help: lt('가'.repeat(501)) })])],
    ['31 questions', () => validateQuestions([], Array.from({ length: 31 }, () => ({ type: 'SHORT_TEXT' as const, label: lt('q'), required: false })))],
    ['unknown type', () => validateQuestions([], [choice({ type: 'RADIO' as never })])],
    ['non-boolean required', () => validateQuestions([], [choice({ required: 'yes' as never })])],
  ])('rejects %s with COHORT_QUESTIONS_INVALID', (_name, run) => {
    expect(code(run)).toBe('COHORT_QUESTIONS_INVALID');
  });

  it('accepts 30 questions and 20 options and counts code points', () => {
    expect(validateQuestions([], Array.from({ length: 30 }, () => ({ type: 'SHORT_TEXT' as const, label: lt('q'), required: false })))).toHaveLength(30);
    expect(validateQuestions([], [choice({ options: Array.from({ length: 20 }, (_, i) => ({ label: lt(`o${i}`) })) })])[0].options).toHaveLength(20);
    expect(validateQuestions([], [choice({ label: lt('😀'.repeat(200)) })])).toHaveLength(1);
  });

  it('can drop a stored question and a stored option (omitted = removed)', () => {
    const [q] = validateQuestions(DEFAULT_COHORT_QUESTIONS, [choice({ id: 'web3_experience', options: [{ id: 'LT_1Y', label: lt('a') }, { id: 'GT_3Y', label: lt('b') }] })]);
    expect(q.options!.map((o) => o.id)).toEqual(['LT_1Y', 'GT_3Y']);
  });
});

describe('validateAnswers', () => {
  const [web3, interest] = DEFAULT_COHORT_QUESTIONS;
  const text: CohortQuestion = { id: 'why', type: 'LONG_TEXT', label: { ko: '이유', en: null, zh: null }, help: null, required: false, options: null };
  const short: CohortQuestion = { id: 'nick', type: 'SHORT_TEXT', label: { ko: '별칭', en: null, zh: null }, help: null, required: false, options: null };
  const all = [web3, interest, text, short];
  const okAnswers = [{ questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'interest_areas', choices: ['KOL', 'DEVELOPER'] }];

  it('builds snapshots in question order with copied labels; unanswered optional questions are omitted', () => {
    const out = validateAnswers(all, [{ questionId: 'interest_areas', choices: ['KOL', 'DEVELOPER'] }, { questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'why', text: '  이유\n있음 ' }, { questionId: 'nick', text: '   ' }]);
    expect(out.map((a) => a.questionId)).toEqual(['web3_experience', 'interest_areas', 'why']);
    expect(out[0]).toEqual({ questionId: 'web3_experience', type: 'SINGLE_CHOICE', label: web3.label, text: null, choices: [{ id: 'Y1_3', label: web3.options![1].label }], other: null });
    expect(out[1].choices!.map((c) => c.id)).toEqual(['DEVELOPER', 'KOL']); // question option order
    expect(out[2]).toMatchObject({ type: 'LONG_TEXT', text: '이유\n있음', choices: null, other: null });
  });

  it.each([
    ['unknown question', [...okAnswers, { questionId: 'ghost', text: 'x' }]],
    ['unknown option', [{ questionId: 'web3_experience', choices: ['NOPE'] }, okAnswers[1]]],
    ['missing required question', [okAnswers[0]]],
    ['empty choices on a required question', [okAnswers[0], { questionId: 'interest_areas', choices: [] }]],
    ['two choices on SINGLE_CHOICE', [{ questionId: 'web3_experience', choices: ['LT_1Y', 'Y1_3'] }, okAnswers[1]]],
    ['duplicate question answers', [...okAnswers, okAnswers[0]]],
    ['duplicate choice ids', [okAnswers[0], { questionId: 'interest_areas', choices: ['KOL', 'KOL'] }]],
    ['SHORT_TEXT with a newline', [...okAnswers, { questionId: 'nick', text: 'a\nb' }]],
    ['SHORT_TEXT over 200 code points', [...okAnswers, { questionId: 'nick', text: 'x'.repeat(201) }]],
    ['LONG_TEXT over 2000 code points', [...okAnswers, { questionId: 'why', text: 'x'.repeat(2001) }]],
    ['LONG_TEXT with a bidi override', [...okAnswers, { questionId: 'why', text: 'a‮b' }]],
    ['choices on a text question', [...okAnswers, { questionId: 'why', text: 'x', choices: ['a'] }]],
    ['text on a choice question', [{ questionId: 'web3_experience', choices: ['Y1_3'], text: 'x' }, okAnswers[1]]],
  ])('rejects %s with COHORT_ANSWERS_INVALID', (_name, input) => {
    expect(code(() => validateAnswers(all, input as never))).toBe('COHORT_ANSWERS_INVALID');
  });

  it('counts SHORT_TEXT length in code points', () => {
    expect(validateAnswers(all, [...okAnswers, { questionId: 'nick', text: '😀'.repeat(200) }]).at(-1)!.text).toHaveLength(400);
  });

  it('withDetail option needs other (COHORT_OTHER_DETAIL_REQUIRED), keeps it trimmed, and other is dropped when not needed', () => {
    const missing = [okAnswers[0], { questionId: 'interest_areas', choices: ['OTHER'] }];
    expect(code(() => validateAnswers(all, missing))).toBe('COHORT_OTHER_DETAIL_REQUIRED');
    expect(code(() => validateAnswers(all, [okAnswers[0], { questionId: 'interest_areas', choices: ['OTHER'], other: '   ' }]))).toBe('COHORT_OTHER_DETAIL_REQUIRED');
    expect(code(() => validateAnswers(all, [okAnswers[0], { questionId: 'interest_areas', choices: ['OTHER'], other: 'x'.repeat(61) }]))).toBe('COHORT_OTHER_DETAIL_REQUIRED');
    const withOther = validateAnswers(all, [okAnswers[0], { questionId: 'interest_areas', choices: ['KOL', 'OTHER'], other: ' UX 리서치 ' }]);
    expect(withOther[1].other).toBe('UX 리서치');
    const dropped = validateAnswers(all, [okAnswers[0], { questionId: 'interest_areas', choices: ['KOL'], other: 'ignored' }]);
    expect(dropped[1].other).toBeNull();
  });

  it('an optional choice question with no choices is simply unanswered', () => {
    const optional: CohortQuestion = { ...web3, required: false };
    expect(validateAnswers([optional], [{ questionId: 'web3_experience', choices: [] }])).toEqual([]);
  });
});

describe('legacyAnswers', () => {
  const legacy = { answers: [] as ApplicationAnswer[], web3_experience: 'LT_1Y', activity_type: 'OTHER', activity_type_other: '디자이너', interest_areas: ['KOL', 'OTHER'], interest_other: 'UX' };

  it('maps a legacy row to 3 answers including activity_type', () => {
    const out = legacyAnswers(legacy);
    expect(out.map((a) => a.questionId)).toEqual(['web3_experience', 'interest_areas', 'activity_type']);
    expect(out[0].choices).toEqual([{ id: 'LT_1Y', label: DEFAULT_COHORT_QUESTIONS[0].options![0].label }]);
    expect(out[1]).toMatchObject({ choices: [{ id: 'KOL' }, { id: 'OTHER' }], other: 'UX' });
    expect(out[2]).toMatchObject({ label: LEGACY_ACTIVITY_QUESTION.label, choices: [{ id: 'OTHER', label: { ko: '기타' } }], other: '디자이너' });
    expect(out[2].label).toEqual({ ko: '현재 활동 유형', en: 'Current activity', zh: '当前活动类型' });
  });

  it('knows STUDENT, returns stored answers as they are and nothing for a new row without answers', () => {
    expect(legacyAnswers({ ...legacy, activity_type: 'STUDENT', activity_type_other: null })[2].choices).toEqual([{ id: 'STUDENT', label: { ko: '학생', en: 'Student', zh: '学生' } }]);
    const stored = [{ questionId: 'q' } as ApplicationAnswer];
    expect(legacyAnswers({ ...legacy, answers: stored })).toBe(stored);
    expect(legacyAnswers({ answers: [], web3_experience: null, activity_type: null, activity_type_other: null, interest_areas: null, interest_other: null })).toEqual([]);
  });
});

describe('answerCsvCells', () => {
  it('fills one cell per current question and moves answers of removed questions to other_answers', () => {
    const answers = legacyAnswers({ answers: [], web3_experience: 'Y1_3', activity_type: 'OTHER', activity_type_other: '디자이너', interest_areas: ['KOL', 'OTHER'], interest_other: 'UX' });
    const { cells, otherAnswers } = answerCsvCells(DEFAULT_COHORT_QUESTIONS, answers);
    expect(cells).toEqual(['1~3년', 'KOL(인플루언서);기타 (UX)']);
    expect(otherAnswers).toBe('현재 활동 유형: 기타 (디자이너)');
  });

  it('writes text answers as is and unanswered questions as an empty cell', () => {
    const q: CohortQuestion = { id: 'why', type: 'LONG_TEXT', label: { ko: '이유', en: null, zh: null }, help: null, required: false, options: null };
    expect(answerCsvCells([q, DEFAULT_COHORT_QUESTIONS[0]], [{ questionId: 'why', type: 'LONG_TEXT', label: q.label, text: 'a\nb', choices: null, other: null }]))
      .toEqual({ cells: ['a\nb', ''], otherAnswers: '' });
  });

  it('puts "(other)" on the withDetail option of the current question even when it is not the last choice', () => {
    const q: CohortQuestion = { id: 'x', type: 'MULTI_CHOICE', label: { ko: 'x', en: null, zh: null }, help: null, required: false,
      options: [{ id: 'a', label: { ko: 'A', en: null, zh: null }, withDetail: true }, { id: 'b', label: { ko: 'B', en: null, zh: null }, withDetail: false }] };
    const answer: ApplicationAnswer = { questionId: 'x', type: 'MULTI_CHOICE', label: q.label, text: null, choices: q.options!.map((o) => ({ id: o.id, label: o.label })), other: '직접' };
    expect(answerCsvCells([q], [answer]).cells).toEqual(['A (직접);B']);
  });
});
