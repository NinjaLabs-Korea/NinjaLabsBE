import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateHighlightDto, UpdateHighlightDto } from './highlight-admin.controller';

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

const valid = { type: 'MILESTONE', title: 'Launch', description: 'Shipped' };
const mediaPath = '/media/11111111-1111-4111-8111-111111111111';

describe('highlight admin DTOs', () => {
  it('accepts media-path or http(s) images and http(s) or site-relative links', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, imageUrl: mediaPath, linkUrl: 'https://ninjalabs.xyz/x' })).toEqual([]);
    expect(await failedFields(CreateHighlightDto, { ...valid, imageUrl: 'https://cdn.example/a.png', linkUrl: '/bounties/helix-volume-analytics' })).toEqual([]);
  });

  it('bounds title to 200 and description to 2000 characters', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, title: 't'.repeat(200), description: 'd'.repeat(2000) })).toEqual([]);
    expect(await failedFields(CreateHighlightDto, { ...valid, title: 't'.repeat(201), description: 'd'.repeat(2001) })).toEqual(['description', 'title']);
  });

  it('rejects non-http(s) URLs, protocol-relative links and arbitrary relative images', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, imageUrl: '/bounties/x', linkUrl: '//evil.com' })).toEqual(['imageUrl', 'linkUrl']);
    expect(await failedFields(UpdateHighlightDto, { linkUrl: 'javascript:alert(1)' })).toEqual(['linkUrl']);
    expect(await failedFields(UpdateHighlightDto, {})).toEqual([]);
  });

  it('update uses 2x bounds (title 400, description 4000) and accepts legacy site-relative and scheme-less images but not a protocol-relative link', async () => {
    expect(await failedFields(UpdateHighlightDto, { title: 't'.repeat(400), description: 'd'.repeat(4000) })).toEqual([]);
    expect(await failedFields(UpdateHighlightDto, { title: 't'.repeat(401), description: 'd'.repeat(4001) })).toEqual(['description', 'title']);
    const legacyRow = { ...valid, imageUrl: '/images/legacy.png', linkUrl: '/bounties/../x' };
    expect(await failedFields(CreateHighlightDto, legacyRow)).toEqual(['imageUrl', 'linkUrl']);
    expect(await failedFields(UpdateHighlightDto, legacyRow)).toEqual([]);
    expect(await failedFields(UpdateHighlightDto, { imageUrl: 'cdn.example.com/legacy.png', linkUrl: '//evil.com' })).toEqual(['linkUrl']);
  });
});
