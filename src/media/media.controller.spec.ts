import { Response } from 'express';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

describe('MediaController.get', () => {
  const asset = {
    id: '22222222-2222-4222-8222-222222222222',
    file_name: 'cover.webp',
    mime_type: 'image/webp',
    file_size: 1234,
    sha256: 'ab'.repeat(32),
    data: Buffer.from('bytes'),
  };

  function response() {
    const headers: Record<string, string> = {};
    const res = {
      set: jest.fn((values: Record<string, string>) => Object.assign(headers, values)),
      send: jest.fn(),
    };
    return { res, headers };
  }

  it('serves the stored bytes with the stored mime type, a quoted sha256 ETag, an immutable year-long cache and nosniff', async () => {
    const media = { find: jest.fn().mockResolvedValue(asset) };
    const { res, headers } = response();
    await new MediaController(media as unknown as MediaService).get(asset.id, res as unknown as Response);

    expect(media.find).toHaveBeenCalledWith(asset.id);
    expect(headers).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': '1234',
      'Content-Type': 'image/webp',
      ETag: `"${'ab'.repeat(32)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    expect(res.send).toHaveBeenCalledWith(asset.data);
    expect(res.set.mock.invocationCallOrder[0]).toBeLessThan(res.send.mock.invocationCallOrder[0]);
  });

  it('propagates MEDIA_NOT_FOUND without writing headers or a body', async () => {
    const media = { find: jest.fn().mockRejectedValue(Object.assign(new Error('MEDIA_NOT_FOUND'), { status: 404 })) };
    const { res } = response();
    await expect(new MediaController(media as unknown as MediaService).get(asset.id, res as unknown as Response))
      .rejects.toMatchObject({ message: 'MEDIA_NOT_FOUND' });
    expect(res.set).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('upload passes the session user and the multer file to the service', async () => {
    const media = { create: jest.fn().mockResolvedValue({ id: 'x', url: '/media/x' }) };
    const file = { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'a.png', size: 1 };
    const controller = new MediaController(media as unknown as MediaService);
    await expect(controller.upload({ user: { userId: 'u1' } } as never, file)).resolves.toEqual({ id: 'x', url: '/media/x' });
    expect(media.create).toHaveBeenCalledWith('u1', file);
  });
});
