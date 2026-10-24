import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * multer의 fileSize(5 MiB) 초과는 핸들러에 도달하기 전에 413 PayloadTooLargeException으로 끊긴다.
 * 서비스의 `MEDIA_FILE_TOO_LARGE`(400)와 같은 응답으로 맞춰 FE가 한 가지 코드만 처리하게 한다.
 */
@Catch(PayloadTooLargeException)
export class MediaFileTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    const mapped = new BadRequestException('MEDIA_FILE_TOO_LARGE');
    host.switchToHttp().getResponse<Response>().status(mapped.getStatus()).json(mapped.getResponse());
  }
}
