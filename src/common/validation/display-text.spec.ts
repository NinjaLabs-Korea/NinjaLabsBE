import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DisplayBody, DisplayTitle, OptionalDisplayBody, OptionalDisplayTitle } from './display-text';

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
  ['invisible only', '​⁠'],
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

  it('rejects a bidi override in both (RLO)', async () => {
    expect(await failedFields({ title: 'ab‮cd', body: 'ab‮cd' })).toEqual(['body', 'title']);
  });

  it('rejects line breaks in a title only; a body may be multi-line', async () => {
    expect(await failedFields({ title: 'a\nb', body: 'a\nb' })).toEqual(['title']);
  });

  it('trims before validating, so an overlong padded value still fits', async () => {
    expect(await failedFields({ title: '  ab  ', body: '  ab  ' })).toEqual([]);
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

  it.each([...BAD_BOTH, ['bidi override', 'ab‮cd']] as const)('rejects %s for both', async (_name, value) => {
    expect(await failedFields({ title: value, body: value }, OptionalProbe)).toEqual(['body', 'title']);
  });
});
