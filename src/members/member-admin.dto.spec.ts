import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateHighlightDto } from '../highlights/highlight-admin.controller';
import { SearchUsersQueryDto, SetMemberDto } from './member-admin.controller';

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe('admin display order validation', () => {
  it('requires member display order to be 1 or more when given', async () => {
    expect(await failedFields(SetMemberDto, { isMember: true, displayOrder: 1 })).toEqual([]);
    expect(await failedFields(SetMemberDto, { isMember: true })).toEqual([]);
    expect(await failedFields(SetMemberDto, { isMember: true, displayOrder: -5 })).toEqual(['displayOrder']);
  });

  it('requires highlight display order to be 0 or more', async () => {
    const highlight = { type: 'MILESTONE', title: 'Launch', description: 'Shipped' };
    expect(await failedFields(CreateHighlightDto, { ...highlight, displayOrder: 0 })).toEqual([]);
    expect(await failedFields(CreateHighlightDto, { ...highlight, displayOrder: -1 })).toEqual(['displayOrder']);
  });
});

describe('admin user search validation', () => {
  it('rejects search terms longer than any email', async () => {
    expect(await failedFields(SearchUsersQueryDto, { q: 'a'.repeat(320) })).toEqual([]);
    expect(await failedFields(SearchUsersQueryDto, { q: 'a'.repeat(321) })).toEqual(['q']);
  });

  it('trims the search term so a pasted trailing space still matches', () => {
    expect(plainToInstance(SearchUsersQueryDto, { q: '  ninja@x.com ' }).q).toBe('ninja@x.com');
    expect(plainToInstance(SearchUsersQueryDto, { q: '   ' }).q).toBe('');
  });
});
