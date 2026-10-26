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

  it('update caps title at the VARCHAR(200) column (code points), uses 2x for description (4000) and accepts legacy site-relative and scheme-less images but not a protocol-relative link', async () => {
    expect(await failedFields(UpdateHighlightDto, { title: '😀'.repeat(200), description: 'd'.repeat(4000) })).toEqual([]);
    expect(await failedFields(UpdateHighlightDto, { title: 't'.repeat(201), description: 'd'.repeat(4001) })).toEqual(['description', 'title']);
    expect(await failedFields(UpdateHighlightDto, { title: '❤️'.repeat(101) })).toEqual(['title']);
    const legacyRow = { ...valid, imageUrl: '/images/legacy.png', linkUrl: '/bounties/../x' };
    expect(await failedFields(CreateHighlightDto, legacyRow)).toEqual(['imageUrl', 'linkUrl']);
    expect(await failedFields(UpdateHighlightDto, legacyRow)).toEqual([]);
    expect(await failedFields(UpdateHighlightDto, { imageUrl: 'cdn.example.com/legacy.png', linkUrl: '//evil.com' })).toEqual(['linkUrl']);
  });

  it('update rejects null for NOT NULL columns and publish, keeps null as "clear" for the URLs', async () => {
    expect(await failedFields(UpdateHighlightDto, { type: null, title: null, description: null, displayOrder: null, publish: null }))
      .toEqual(['description', 'displayOrder', 'publish', 'title', 'type']);
    expect(await failedFields(UpdateHighlightDto, { imageUrl: null, linkUrl: null })).toEqual([]);
  });

  it('caps displayOrder at the Postgres INTEGER maximum on create and update', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, displayOrder: 2_147_483_647 })).toEqual([]);
    expect(await failedFields(CreateHighlightDto, { ...valid, displayOrder: 2_147_483_648 })).toEqual(['displayOrder']);
    expect(await failedFields(UpdateHighlightDto, { displayOrder: 2_147_483_648 })).toEqual(['displayOrder']);
  });
});

describe('highlight admin DTOs: visible text, public links', () => {
  it('rejects a title or description made only of zero-width characters (create and update)', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, title: '\u200B\u200B', description: '\u200B\u200B' })).toEqual(['description', 'title']);
    expect(await failedFields(UpdateHighlightDto, { title: '\u200B', description: '\u3164' })).toEqual(['description', 'title']);
    expect(await failedFields(CreateHighlightDto, { ...valid, title: 'ok\u200B' })).toEqual(['title']);
  });

  it('create linkUrl must be a public http(s) URL or a site path: localhost and private hosts are refused', async () => {
    for (const linkUrl of ['http://localhost:3000/x', 'http://10.0.0.1/x', 'http://127.0.0.1/x', 'http://intranet/x']) {
      expect(await failedFields(CreateHighlightDto, { ...valid, linkUrl })).toEqual(['linkUrl']);
    }
    expect(await failedFields(CreateHighlightDto, { ...valid, linkUrl: 'https://injective.com/blog' })).toEqual([]);
    expect(await failedFields(CreateHighlightDto, { ...valid, linkUrl: '/bounties/x' })).toEqual([]);
  });
});

describe('highlight bidi hygiene', () => {
  it('rejects bidi override in title and description', async () => {
    expect(await failedFields(CreateHighlightDto, { ...valid, title: 'a‮b' })).toEqual(['title']);
    expect(await failedFields(UpdateHighlightDto, { description: 'a‮b' })).toEqual(['description']);
  });
});
