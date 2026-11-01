import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { mediaPath } from './media-path';

/** 운영자 업로드 상한 (0012 media_asset.file_size CHECK와 같은 값) */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
/** 회원 프로필 사진 상한 - 작게 보이는 원형 이미지라 운영자 상한보다 작게 둔다 (POST /users/me/avatar) */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

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
    return insertImageAsset(this.db, userId, file, MAX_MEDIA_BYTES);
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
}

/**
 * 이미지 한 장을 검증하고 media_asset에 넣는다 - 운영자 업로드(MediaService.create)와 회원 프로필 사진(users/user-avatar.service.ts)이
 * 같은 규칙(파일 필수, 크기 상한, 선언된 mimetype의 매직바이트)을 쓴다. 프로필 사진은 유저 행 갱신과 같은 트랜잭션에서 넣으므로
 * DatabaseService와 트랜잭션 클라이언트를 모두 받는다.
 */
export async function insertImageAsset(
  runner: QueryRunner,
  userId: string,
  file: UploadedImage | undefined,
  maxBytes: number,
): Promise<{ id: string; url: string }> {
  if (!file?.buffer?.length) throw new BadRequestException('MEDIA_FILE_REQUIRED');
  if (file.size > maxBytes) throw new BadRequestException('MEDIA_FILE_TOO_LARGE');
  if (!isValidImage(file)) throw new BadRequestException('MEDIA_FILE_TYPE_UNSUPPORTED');

  const hash = createHash('sha256').update(file.buffer).digest('hex');
  const inserted = (await runner.query(
    `INSERT INTO media_asset (created_by, file_name, mime_type, file_size, sha256, data)
     VALUES ($1::uuid, $2::varchar, $3::varchar, $4::int, $5::text, $6::bytea)
     RETURNING id`,
    [userId, file.originalname.slice(0, 255), file.mimetype, file.size, hash, file.buffer],
  )) as { rows: Array<{ id: string }> };
  const id = inserted.rows[0].id;
  return { id, url: mediaPath(id) };
}

function isValidImage(file: UploadedImage): boolean {
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
