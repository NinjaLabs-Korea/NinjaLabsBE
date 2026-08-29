import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
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

  it('persists a validated image and returns its public URL', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ id: '22222222-2222-4222-8222-222222222222' }],
      }),
    };
    const service = new MediaService(db as unknown as DatabaseService);

    await expect(service.create(userId, image())).resolves.toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      url: '/media/22222222-2222-4222-8222-222222222222',
    });
    expect(db.query.mock.calls[0][1][0]).toBe(userId);
    expect(db.query.mock.calls[0][1][4]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects spoofed and oversized image uploads', async () => {
    const service = new MediaService({ query: jest.fn() } as unknown as DatabaseService);

    await expect(service.create(userId, image({ buffer: Buffer.from('not-png') })))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(userId, image({ size: MAX_MEDIA_BYTES + 1 })))
      .rejects.toMatchObject({ message: 'MEDIA_FILE_TOO_LARGE' });
  });

  it('returns not found for an unknown asset', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const service = new MediaService(db as unknown as DatabaseService);

    await expect(service.find('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
