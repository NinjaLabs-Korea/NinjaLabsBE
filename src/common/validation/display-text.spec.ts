import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DisplayBody, DisplayTitle, NullableDisplayBody, OptionalDisplayBody, OptionalDisplayTitle } from './display-text';

class Probe {
  @DisplayTitle(10) title!: string;
  @DisplayBody(10) body!: string;
}

class OptionalProbe {
  @OptionalDisplayTitle(10) title?: string;
  @OptionalDisplayBody(10) body?: string;
}

const failedFields = async (body: object, cls: new () => object = Probe) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

const valid = { title: '닌자랩스 공지', body: '본문입니다' };
const BAD_BOTH = [
  ['empty', ''],
  ['whitespace only', '   '],
  ['invisible only', '\u200b\u2060'],
  ['too long (max + 1)', 'a'.repeat(11)],
] as const;

describe('DisplayTitle / DisplayBody', () => {
  it('accepts a normal Korean title and body', async () => {
    expect(await failedFields(valid)).toEqual([]);
  });

  it.each(BAD_BOTH)('rejects %s for both', async (_name, value) => {
    expect(await failedFields({ title: value, body: value })).toEqual(['body', 'title']);
  });

  it('counts the title limit in code points (variation selectors included)', async () => {
    expect(await failedFields({ title: '❤️'.repeat(5), body: valid.body })).toEqual([]);
    expect(await failedFields({ title: '❤️'.repeat(6), body: valid.body })).toEqual(['title']);
  });

  it('counts non-BMP characters (surrogate pairs) as one code point, never as two UTF-16 units', async () => {
    // 10 code points = 20 UTF-16 units: fails if a length rule ever counts UTF-16 units.
    expect(await failedFields({ title: '😀'.repeat(10), body: '😀'.repeat(10) })).toEqual([]);
    expect(await failedFields({ title: '😀'.repeat(11), body: '😀'.repeat(11) })).toEqual(['body', 'title']);
  });

  it('only the title counts variation selectors; the body (MaxLength) ignores them', async () => {
    // Title: MaxChars matches Postgres char_length. Body: validator.js isLength drops U+FE0F, so 6 hearts count as 6.
    expect(await failedFields({ title: valid.title, body: '❤️'.repeat(6) })).toEqual([]);
  });

  it('rejects a bidi override in both (RLO)', async () => {
    expect(await failedFields({ title: 'ab\u202ecd', body: 'ab\u202ecd' })).toEqual(['body', 'title']);
  });

  it('rejects line breaks in a title only; a body may be multi-line', async () => {
    expect(await failedFields({ title: 'a\nb', body: 'a\nb' })).toEqual(['title']);
  });

  it('trims before validating, so an overlong padded value still fits', async () => {
    const padded = '  ' + 'a'.repeat(10) + '  '; // 14 chars untrimmed, 10 trimmed
    expect(await failedFields({ title: padded, body: padded })).toEqual([]);
  });

  it('rejects non-strings', async () => {
    expect(await failedFields({ title: 5, body: 5 })).toEqual(['body', 'title']);
  });
});

describe('OptionalDisplayTitle / OptionalDisplayBody', () => {
  it('lets omitted fields through and accepts a normal value', async () => {
    expect(await failedFields({}, OptionalProbe)).toEqual([]);
    expect(await failedFields(valid, OptionalProbe)).toEqual([]);
  });

  it('rejects null (NOT NULL columns)', async () => {
    expect(await failedFields({ title: null, body: null }, OptionalProbe)).toEqual(['body', 'title']);
  });

  it.each([...BAD_BOTH, ['bidi override', 'ab\u202ecd']] as const)('rejects %s for both', async (_name, value) => {
    expect(await failedFields({ title: value, body: value }, OptionalProbe)).toEqual(['body', 'title']);
  });
});

class NullableProbe {
  @NullableDisplayBody(10) note?: string | null;
}

describe('NullableDisplayBody', () => {
  const noteErrors = async (body: object) => (await validate(plainToInstance(NullableProbe, body))).length;

  it('lets omitted, null and a normal value through', async () => {
    expect(await noteErrors({})).toBe(0);
    expect(await noteErrors({ note: null })).toBe(0);
    expect(await noteErrors({ note: '메모' })).toBe(0);
  });

  it('turns an invisible-only or blank value into null', async () => {
    for (const value of ['\u200b\u2060', '   ']) {
      const probe = plainToInstance(NullableProbe, { note: value });
      expect(probe.note).toBeNull();
      expect(await validate(probe)).toEqual([]);
    }
  });

  it('trims a padded value', () => {
    expect(plainToInstance(NullableProbe, { note: '  ab  ' }).note).toBe('ab');
  });

  it.each([
    ['bidi override', 'ab\u202ecd'],
    ['too long (max + 1)', 'a'.repeat(11)],
    ['non-string', 5],
  ])('rejects %s', async (_name, value) => {
    expect(await noteErrors({ note: value })).toBe(1);
  });
});
