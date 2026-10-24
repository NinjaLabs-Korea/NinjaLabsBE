import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

const failedFields = async (query: object) =>
  (await validate(plainToInstance(PaginationQueryDto, query))).map((error) => error.property).sort();

describe('PaginationQueryDto', () => {
  it('accepts omitted values and numeric strings', async () => {
    expect(await failedFields({})).toEqual([]);
    expect(await failedFields({ page: '2', pageSize: '50' })).toEqual([]);
    const dto = plainToInstance(PaginationQueryDto, { page: '2', pageSize: '12' });
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(12);
  });

  it('rejects non-numeric, zero, negative, fractional and oversized values', async () => {
    expect(await failedFields({ page: 'abc' })).toEqual(['page']);
    expect(await failedFields({ page: '0', pageSize: '51' })).toEqual(['page', 'pageSize']);
    expect(await failedFields({ page: '-1', pageSize: '1.5' })).toEqual(['page', 'pageSize']);
    expect(await failedFields({ pageSize: '' })).toEqual(['pageSize']);
    expect(await failedFields({ page: '100000' })).toEqual([]);
    expect(await failedFields({ page: '100001' })).toEqual(['page']);
  });
});
