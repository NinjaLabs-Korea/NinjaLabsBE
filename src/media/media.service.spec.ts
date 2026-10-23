import { BadRequestException, NotFoundException } from '@nestjs/common';
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
});
