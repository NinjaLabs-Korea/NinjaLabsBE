import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CohortApplicationFields, UpdateCohortApplicationDto, normalizeHandle } from './cohort-fields';

const valid = {
  displayName: '  홍길동 ', telegram: 'https://t.me/ninja_kr', twitter: '@Ninja_KR', intro: ' hello ',
  answers: [{ questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'interest_areas', choices: ['DEVELOPER', 'KOL'] }],
};
/** 옛 FE 본문 (FE 릴리스 #69 전): 이제 DTO 에 없는 필드라 forbidNonWhitelisted 로 거절된다 */
const LEGACY_BODY = { web3Experience: 'Y1_3', activityType: 'OTHER', activityTypeOther: 'farmer', interestAreas: ['DEVELOPER', 'OTHER'], interestOther: 'art' };
async function check<T extends object>(cls: new () => T, plain: object) {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property) };
}

describe('handle normalization', () => {
  const tg = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.*)$/i;
  it('accepts @name, name and URLs and always yields @name', () => {
    expect(normalizeHandle('@name', tg)).toBe('@name');
    expect(normalizeHandle('name', tg)).toBe('@name');
    expect(normalizeHandle(' @@name ', tg)).toBe('@name');
    expect(normalizeHandle('https://t.me/name?start=1', tg)).toBe('@name');
    expect(normalizeHandle('t.me/name/', tg)).toBe('@name');
    expect(normalizeHandle('', tg)).toBe('');
    expect(normalizeHandle(5, tg)).toBe(5);
    expect(normalizeHandle('https://t.me/valid_name', tg)).toBe('@valid_name');
    expect(normalizeHandle('t.me/valid_name?start=1', tg)).toBe('@valid_name');
  });

  it.each([
    't.me/joinchat/AAAA', 'https://t.me/JoinChat/AAAA', 'https://t.me/share/url?url=x', 't.me/c/123/4', 't.me/name/12', 't.me/+AbCdEf/x', 't.me/addstickers/pack', 't.me/joinchat',
  ])('keeps non-profile telegram link %s unchanged so the handle check fails', async (input) => {
    expect(normalizeHandle(input, tg)).toBe(input);
    const { errors } = await check(CohortApplicationFields, { ...valid, telegram: input });
    expect(errors).toContain('telegram');
  });

  it('applies the same rule to X post/intent links', async () => {
    const tw = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(.*)$/i;
    expect(normalizeHandle('https://x.com/name/status/1', tw)).toBe('https://x.com/name/status/1');
    expect(normalizeHandle('x.com/intent/tweet?text=a', tw)).toBe('x.com/intent/tweet?text=a');
    expect(normalizeHandle('x.com/i/flow/login', tw)).toBe('x.com/i/flow/login');
    expect(normalizeHandle('https://x.com/Ninja_KR?s=20', tw)).toBe('@Ninja_KR');
  });
});

describe('CohortApplicationFields', () => {
  it('normalizes and accepts a valid application (handles, trimmed text)', async () => {
    const { dto, errors } = await check(CohortApplicationFields, valid);
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ displayName: '홍길동', telegram: '@ninja_kr', twitter: '@Ninja_KR', intro: 'hello' });
  });

  it.each([
    ['telegram', 'abc'], ['telegram', 'a b c d e'], ['telegram', '1abcde'], ['twitter', 'x'.repeat(16)], ['twitter', 'bad-handle'],
    ['answers', undefined], ['answers', null], ['answers', 'web3_experience'],
    ['displayName', '   '], ['displayName', 'x'.repeat(61)], ['intro', '   '], ['intro', 'x'.repeat(1001)],
  ])('rejects %s = %j', async (field, value) => {
    const { errors } = await check(CohortApplicationFields, { ...valid, [field]: value });
    expect(errors).toContain(field);
  });

  it('counts emoji by code point like Postgres (60 flags ok, 61 not)', async () => {
    expect((await check(CohortApplicationFields, { ...valid, displayName: '🥷'.repeat(60) })).errors).toEqual([]);
    expect((await check(CohortApplicationFields, { ...valid, displayName: '🥷'.repeat(61) })).errors).toContain('displayName');
  });

  it('rejects unknown fields (forbidNonWhitelisted)', async () => {
    expect((await check(CohortApplicationFields, { ...valid, status: 'ACCEPTED' })).errors).toContain('status');
  });
});

describe.each([['create', CohortApplicationFields], ['update', UpdateCohortApplicationDto]] as const)('visible text rules (%s)', (_name, cls) => {
  const run = (patch: object) => check(cls as new () => object, { ...valid, ...patch });
  it.each([
    ['displayName', '\u200B\u200B'], ['displayName', 'ab\u202Ecd'], ['displayName', 'a\nb'], ['displayName', '\u3164\u2800'],
    ['intro', '\u200B\u200B\u200B'], ['intro', 'hi \u202E evil'], ['intro', 'x\u2066y'],
  ])('rejects %s = %j', async (field, value) => {
    expect((await run({ [field]: value })).errors).toContain(field);
  });
  it('accepts Korean/emoji names with ZWJ and multi-line intro', async () => {
    const { errors } = await run({ displayName: '홍길동 👩‍💻', intro: 'line1\nline2\r\n\nline4' });
    expect(errors).toEqual([]);
  });
});

describe('UpdateCohortApplicationDto', () => {
  it('everything is optional but NOT NULL fields reject null', async () => {
    expect((await check(UpdateCohortApplicationDto, {})).errors).toEqual([]);
    for (const field of ['displayName', 'telegram', 'twitter', 'answers', 'intro']) {
      expect((await check(UpdateCohortApplicationDto, { [field]: null })).errors).toContain(field);
    }
  });
});

describe('old (pre-#69) body is no longer accepted', () => {
  const fixed = { displayName: '홍길동', telegram: '@ninja_kr', twitter: '@ninja', intro: 'hello' };
  it('create: the old fields alone are a DTO validation error on answers plus every old field', async () => {
    const { errors } = await check(CohortApplicationFields, { ...fixed, ...LEGACY_BODY });
    expect(errors.sort()).toEqual(['activityType', 'activityTypeOther', 'answers', 'interestAreas', 'interestOther', 'web3Experience']);
  });
  it.each(Object.keys(LEGACY_BODY))('create and update: %s next to answers is forbidden (even null)', async (field) => {
    expect((await check(CohortApplicationFields, { ...valid, [field]: LEGACY_BODY[field as keyof typeof LEGACY_BODY] })).errors).toEqual([field]);
    expect((await check(UpdateCohortApplicationDto, { [field]: null })).errors).toEqual([field]);
  });
});

describe('answers body', () => {
  const fixed = { displayName: '홍길동', telegram: '@ninja_kr', twitter: '@ninja', intro: 'hello' };
  const answers = [{ questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'why', text: '이유' }, { questionId: 'x', choices: ['OTHER'], other: '직접' }];

  it('accepts a body with answers, on create and update; an empty answers array is a valid shape', async () => {
    expect((await check(CohortApplicationFields, { ...fixed, answers })).errors).toEqual([]);
    expect((await check(CohortApplicationFields, { ...fixed, answers: [] })).errors).toEqual([]);
    expect((await check(UpdateCohortApplicationDto, { answers })).errors).toEqual([]);
  });

  it('checks the answer shape: id pattern, unique choices, 20 choices, 30 answers, no extra keys, answers not null', async () => {
    expect((await check(CohortApplicationFields, { ...fixed, answers: [{ questionId: 'bad id!' }] })).errors).toEqual(['answers']);
    expect((await check(CohortApplicationFields, { ...fixed, answers: [{ questionId: 'a', choices: ['x', 'x'] }] })).errors).toEqual(['answers']);
    expect((await check(CohortApplicationFields, { ...fixed, answers: [{ questionId: 'a', choices: Array.from({ length: 21 }, (_, i) => `c${i}`) }] })).errors).toEqual(['answers']);
    expect((await check(CohortApplicationFields, { ...fixed, answers: Array.from({ length: 31 }, (_, i) => ({ questionId: `q${i}` })) })).errors).toEqual(['answers']);
    expect((await check(CohortApplicationFields, { ...fixed, answers: [{ questionId: 'a', extra: 1 }] })).errors).toEqual(['answers']);
    expect((await check(CohortApplicationFields, { ...fixed, answers: [{ questionId: 'a', other: 'x'.repeat(61) }] })).errors).toEqual(['answers']);
    expect((await check(UpdateCohortApplicationDto, { answers: null })).errors).toEqual(['answers']);
  });
});
