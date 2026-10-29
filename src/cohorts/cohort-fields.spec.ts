import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CohortApplicationFields, UpdateCohortApplicationDto, normalizeHandle, normalizeOtherDetails } from './cohort-fields';

const valid = {
  displayName: '  홍길동 ', telegram: 'https://t.me/ninja_kr', twitter: '@Ninja_KR', web3Experience: 'Y1_3',
  activityType: 'DEVELOPER', interestAreas: ['DEVELOPER', 'KOL', 'DEVELOPER'], intro: ' hello ',
};
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
  it('normalizes and accepts a valid application (handles, trimmed text, de-duplicated interest areas)', async () => {
    const { dto, errors } = await check(CohortApplicationFields, valid);
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ displayName: '홍길동', telegram: '@ninja_kr', twitter: '@Ninja_KR', intro: 'hello', interestAreas: ['DEVELOPER', 'KOL'] });
  });

  it.each([
    ['telegram', 'abc'], ['telegram', 'a b c d e'], ['telegram', '1abcde'], ['twitter', 'x'.repeat(16)], ['twitter', 'bad-handle'],
    ['web3Experience', 'GT_10Y'], ['activityType', 'NINJA'], ['interestAreas', []], ['interestAreas', ['STUDENT']], ['interestAreas', 'DEVELOPER'],
    ['displayName', '   '], ['displayName', 'x'.repeat(61)], ['intro', '   '], ['intro', 'x'.repeat(1001)], ['activityTypeOther', 'x'.repeat(61)],
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

describe('UpdateCohortApplicationDto', () => {
  it('everything is optional but NOT NULL fields reject null', async () => {
    expect((await check(UpdateCohortApplicationDto, {})).errors).toEqual([]);
    for (const field of ['displayName', 'telegram', 'twitter', 'web3Experience', 'activityType', 'interestAreas', 'intro']) {
      expect((await check(UpdateCohortApplicationDto, { [field]: null })).errors).toContain(field);
    }
    expect((await check(UpdateCohortApplicationDto, { activityTypeOther: null, interestOther: null })).errors).toEqual([]);
  });
});

describe('normalizeOtherDetails', () => {
  const base = { activityType: 'DEVELOPER', interestAreas: ['KOL'] };
  it('drops details that are not selected', () => {
    expect(normalizeOtherDetails({ ...base, activityTypeOther: 'x', interestOther: 'y' })).toMatchObject({ activityTypeOther: null, interestOther: null });
  });
  it('keeps trimmed details when OTHER is selected', () => {
    expect(normalizeOtherDetails({ activityType: 'OTHER', activityTypeOther: ' farmer ', interestAreas: ['OTHER'], interestOther: ' art ' }))
      .toMatchObject({ activityTypeOther: 'farmer', interestOther: 'art' });
  });
  it('requires details when OTHER is selected (COHORT_OTHER_DETAIL_REQUIRED)', () => {
    expect(() => normalizeOtherDetails({ ...base, activityType: 'OTHER' })).toThrow('COHORT_OTHER_DETAIL_REQUIRED');
    expect(() => normalizeOtherDetails({ ...base, interestAreas: ['KOL', 'OTHER'], interestOther: '  ' })).toThrow('COHORT_OTHER_DETAIL_REQUIRED');
  });
});
