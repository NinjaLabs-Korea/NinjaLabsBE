import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateNoticeDto, UpdateNoticeDto } from './notice-admin.controller';

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

const valid = { title: 'Launch', body: 'We shipped.', category: 'NINJALABS' };
const mediaPath = '/media/11111111-1111-4111-8111-111111111111';

describe('notice admin DTOs', () => {
  it('accepts a complete notice with media-path thumbnail and external http(s) link', async () => {
    expect(await failedFields(CreateNoticeDto, { ...valid, summary: 's', thumbnailUrl: mediaPath, externalUrl: 'https://x.com/a', publish: true })).toEqual([]);
    expect(await failedFields(CreateNoticeDto, { ...valid, thumbnailUrl: 'https://cdn.example/x.png' })).toEqual([]);
  });

  it('bounds free text: title 200, summary 500, body 50000', async () => {
    expect(await failedFields(CreateNoticeDto, { ...valid, title: 'a'.repeat(200), summary: 's'.repeat(500), body: 'b'.repeat(50_000) })).toEqual([]);
    expect(await failedFields(CreateNoticeDto, { ...valid, title: 'a'.repeat(201), summary: 's'.repeat(501), body: 'b'.repeat(50_001) })).toEqual(['body', 'summary', 'title']);
    expect(await failedFields(CreateNoticeDto, { ...valid, title: '   ' })).toEqual(['title']);
  });

  it('rejects non-http(s) or malformed URLs, and a media path where only external links are allowed', async () => {
    expect(await failedFields(CreateNoticeDto, { ...valid, thumbnailUrl: 'javascript:alert(1)', externalUrl: 'ninjalabs.xyz' })).toEqual(['externalUrl', 'thumbnailUrl']);
    expect(await failedFields(CreateNoticeDto, { ...valid, externalUrl: mediaPath })).toEqual(['externalUrl']);
    expect(await failedFields(CreateNoticeDto, { ...valid, thumbnailUrl: '/media/not-a-uuid' })).toEqual(['thumbnailUrl']);
  });

  it('lets updates omit fields, keeps blank-title protection and caps title at VARCHAR(200), uses 2x bounds for TEXT (summary 1000, body 100000)', async () => {
    expect(await failedFields(UpdateNoticeDto, {})).toEqual([]);
    expect(await failedFields(UpdateNoticeDto, { title: 'a'.repeat(200), summary: 's'.repeat(1000), body: 'b'.repeat(100_000) })).toEqual([]);
    expect(await failedFields(UpdateNoticeDto, { title: 'a'.repeat(201) })).toEqual(['title']);
    expect(await failedFields(UpdateNoticeDto, { title: '', body: 'b'.repeat(100_001), summary: 's'.repeat(1001) })).toEqual(['body', 'summary', 'title']);
  });

  it('update accepts legacy URL shapes the FE re-sends unchanged (site-relative or scheme-less thumbnail/external link) but not unsafe schemes', async () => {
    const legacyRow = { ...valid, thumbnailUrl: '/uploads/old-thumb.jpg', externalUrl: '/notices/old-slug' };
    expect(await failedFields(CreateNoticeDto, legacyRow)).toEqual(['externalUrl', 'thumbnailUrl']);
    expect(await failedFields(UpdateNoticeDto, legacyRow)).toEqual([]);
    expect(await failedFields(UpdateNoticeDto, { thumbnailUrl: 'data:image/png;base64,AAAA', externalUrl: 'javascript:alert(1)' })).toEqual(['externalUrl', 'thumbnailUrl']);
    expect(await failedFields(UpdateNoticeDto, { ...legacyRow, externalUrl: 'ninjalabs.xyz/post' })).toEqual([]);
    expect(await failedFields(CreateNoticeDto, { ...valid, externalUrl: 'ninjalabs.xyz/post' })).toEqual(['externalUrl']);
  });

  it('update rejects null for NOT NULL columns (title/body/category) and publish, keeps null as "clear" for summary and URLs', async () => {
    expect(await failedFields(UpdateNoticeDto, { title: null, body: null, category: null, publish: null })).toEqual(['body', 'category', 'publish', 'title']);
    expect(await failedFields(UpdateNoticeDto, { summary: null, thumbnailUrl: null, externalUrl: null })).toEqual([]);
  });
});
