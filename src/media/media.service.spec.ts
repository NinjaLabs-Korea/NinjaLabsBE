import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { MAX_MEDIA_BYTES, MediaService, UploadedImage } from './media.service';

describe('MediaService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
    const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    return {
      buffer,
      mimetype: 'image/png',
      originalname: 'cover.png',
      size: buffer.length,
      ...overrides,
    };
  }

  const serviceWith = (query: jest.Mock) => new MediaService({ query: withParamsCheck(query) } as unknown as DatabaseService);

  it('persists a validated image and returns its public URL', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: '22222222-2222-4222-8222-222222222222' }],
    });
    const service = serviceWith(query);

    await expect(service.create(userId, image())).resolves.toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      url: '/media/22222222-2222-4222-8222-222222222222',
    });
    expect(query.mock.calls[0][1][0]).toBe(userId);
    expect(query.mock.calls[0][1][4]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects spoofed and oversized image uploads', async () => {
    const query = jest.fn();
    const service = serviceWith(query);

    await expect(service.create(userId, image({ buffer: Buffer.from('not-png') })))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(userId, image({ size: MAX_MEDIA_BYTES + 1 })))
      .rejects.toMatchObject({ message: 'MEDIA_FILE_TOO_LARGE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns not found for an unknown asset', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const service = serviceWith(query);

    await expect(service.find('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(query.mock.calls[0][1]).toEqual(['missing']);
  });
  it.each([
    ['no file part at all', undefined],
    ['an empty file', { buffer: Buffer.alloc(0), size: 0 }],
  ])('rejects %s with 400 MEDIA_FILE_REQUIRED', async (_label, overrides) => {
    const query = jest.fn();
    const service = serviceWith(query);
    const file = overrides === undefined ? undefined : image(overrides);
    await expect(service.create(userId, file)).rejects.toMatchObject({ status: 400, message: 'MEDIA_FILE_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

  it.each([
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
  ])('accepts %s with matching magic bytes', async (mimetype, buffer) => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'id-1' }] });
    await expect(serviceWith(query).create(userId, image({ mimetype, buffer, size: buffer.length })))
      .resolves.toEqual({ id: 'id-1', url: '/media/id-1' });
    expect(query.mock.calls[0][1][2]).toBe(mimetype);
  });

  it.each([
    ['gif (not allowed even with valid magic)', 'image/gif', Buffer.from('GIF89a\x01\x00\x01\x00')],
    ['svg (script-capable)', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['png declared, jpeg bytes', 'image/png', JPEG],
    ['png signature truncated to 7 bytes', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26])],
    ['jpeg declared, only 2 magic bytes', 'image/jpeg', Buffer.from([0xff, 0xd8])],
    ['RIFF container that is not WEBP (e.g. WAV)', 'image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])],
    ['webp shorter than 12 bytes', 'image/webp', Buffer.from('RIFF\0\0\0\0WEB')],
  ])('rejects %s with 400 MEDIA_FILE_TYPE_UNSUPPORTED', async (_label, mimetype, buffer) => {
    const query = jest.fn();
    await expect(serviceWith(query).create(userId, image({ mimetype, buffer, size: buffer.length })))
      .rejects.toMatchObject({ status: 400, message: 'MEDIA_FILE_TYPE_UNSUPPORTED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts exactly MAX_MEDIA_BYTES (the limit is inclusive)', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'id-1' }] });
    await expect(serviceWith(query).create(userId, image({ size: MAX_MEDIA_BYTES }))).resolves.toMatchObject({ id: 'id-1' });
  });

  it('binds the sha256 of the exact bytes, the declared size and the bytes themselves, truncating the file name to 255 chars', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'id-1' }] });
    const file = image({ originalname: `${'a'.repeat(300)}.png` });
    await serviceWith(query).create(userId, file);
    const params = query.mock.calls[0][1];
    expect(params).toEqual([userId, 'a'.repeat(255), 'image/png', file.size, createHash('sha256').update(file.buffer).digest('hex'), file.buffer]);
  });
});
