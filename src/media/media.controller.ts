import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { SessionUser } from '../auth/auth.service';
import { MAX_MEDIA_BYTES, MediaService, UploadedImage } from './media.service';

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('admin/media')
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: MAX_MEDIA_BYTES } }))
  upload(
    @Req() req: Request & { user: SessionUser },
    @UploadedFile() file?: UploadedImage,
  ) {
    return this.media.create(req.user.userId, file);
  }

  @Get('media/:id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ) {
    const asset = await this.media.find(id);
    response.set({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(asset.file_size),
      'Content-Type': asset.mime_type,
      ETag: `"${asset.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(asset.data);
  }
}
