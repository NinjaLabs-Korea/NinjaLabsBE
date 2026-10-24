import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsInt, IsOptional, IsString, validate } from 'class-validator';
import { IsOptionalNotNull, MaxPgInt, PG_INT_MAX } from './optional-not-null';

class Probe {
  @IsOptionalNotNull() @IsString() title?: string;
  @IsOptional() @IsString() url?: string | null;
  @IsOptionalNotNull() @IsInt() @MaxPgInt() order?: number;
}

const failed = async (body: object) =>
  (await validate(plainToInstance(Probe, body))).flatMap((error) => Object.values(error.constraints ?? {}));

describe('IsOptionalNotNull / MaxPgInt', () => {
  it('lets an omitted field through but rejects null with a clear message', async () => {
    expect(await failed({})).toEqual([]);
    expect(await failed({ title: 'x', order: 1 })).toEqual([]);
    expect(await failed({ title: null })).toEqual(expect.arrayContaining(['title should not be null']));
  });

  it('keeps null meaning "clear" on nullable fields declared with IsOptional', async () => {
    expect(await failed({ url: null })).toEqual([]);
  });

  it('caps integers at the Postgres INTEGER maximum', async () => {
    expect(await failed({ order: PG_INT_MAX })).toEqual([]);
    expect(await failed({ order: PG_INT_MAX + 1 })).toEqual([`order must not be greater than ${PG_INT_MAX}`]);
  });
});
