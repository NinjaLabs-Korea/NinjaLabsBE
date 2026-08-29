import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export type UploadedImage = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

type MediaRow = {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  data: Buffer;
};

@Injectable()
export class MediaService {
  constructor(private readonly db: DatabaseService) {}

  async create(userId: string, file?: UploadedImage) {
    if (!file?.buffer?.length) throw new BadRequestException('MEDIA_FILE_REQUIRED');
    if (file.size > MAX_MEDIA_BYTES) throw new BadRequestException('MEDIA_FILE_TOO_LARGE');
    if (!this.isValidImage(file)) throw new BadRequestException('MEDIA_FILE_TYPE_UNSUPPORTED');

    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO media_asset (created_by, file_name, mime_type, file_size, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, file.originalname.slice(0, 255), file.mimetype, file.size, hash, file.buffer],
    );
    const id = inserted.rows[0].id;
    return { id, url: `/media/${id}` };
  }

  async find(id: string): Promise<MediaRow> {
    const result = await this.db.query<MediaRow>(
      `SELECT id, file_name, mime_type, file_size, sha256, data
         FROM media_asset WHERE id = $1`,
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('MEDIA_NOT_FOUND');
    return result.rows[0];
  }

  private isValidImage(file: UploadedImage): boolean {
    const bytes = file.buffer;
    if (file.mimetype === 'image/png') {
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    if (file.mimetype === 'image/jpeg') {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (file.mimetype === 'image/webp') {
      return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    }
    return false;
  }
}
