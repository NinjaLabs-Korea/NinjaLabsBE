import { ArgumentsHost, PayloadTooLargeException } from '@nestjs/common';
import { MediaFileTooLargeFilter } from './media-file-too-large.filter';

describe('MediaFileTooLargeFilter', () => {
  it('maps multer PayloadTooLarge (413) to 400 MEDIA_FILE_TOO_LARGE like the service check', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    new MediaFileTooLargeFilter().catch(new PayloadTooLargeException('File too large'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'MEDIA_FILE_TOO_LARGE' }));
  });
});
