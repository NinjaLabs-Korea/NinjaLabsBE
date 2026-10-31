import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { Request, Response } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { SessionUser } from '../auth/auth.service';
import { MediaFileTooLargeFilter } from './media-file-too-large.filter';
import { MAX_MEDIA_BYTES, MediaService, UploadedImage } from './media.service';

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('admin/media')
  @UseGuards(AdminGuard)
  // multer 한도: 파일 1개·5 MiB 외에 필드/파트 수와 필드명 길이도 막는다 (multipart 폭탄 방지)
  // defParamCharset: multer는 charset 없는 filename을 latin1로 읽는다 - 브라우저는 UTF-8 바이트로 보내므로 한글 파일명이 깨져 저장됐다
  @UseInterceptors(FileInterceptor('file', {
    defParamCharset: 'utf8',
    limits: { files: 1, fileSize: MAX_MEDIA_BYTES, fields: 5, parts: 10, fieldNameSize: 100 },
  }))
  @UseFilters(MediaFileTooLargeFilter)
  upload(
    @Req() req: Request & { user: SessionUser },
    @UploadedFile() file?: UploadedImage,
  ) {
    return this.media.create(req.user.userId, file);
  }

  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get('media/:id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ) {
    const asset = await this.media.find(id);
    response.set({
      // helmet은 전역으로 `same-origin`을 둔다 - 공개 이미지는 FE 오리진(rewrite가 아닌 절대 BE URL, 마크다운 본문의 `![](…)` 등)의 <img>가 불러야 하므로 이 응답만 푼다
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(asset.file_size),
      'Content-Type': asset.mime_type,
      ETag: `"${asset.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(asset.data);
  }
}
