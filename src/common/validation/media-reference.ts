import { BadRequestException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { isMediaPath } from './url';

/**
 * 이미지 필드가 `/media/<uuid>` 경로면 그 에셋이 실제로 있어야 한다 - 없는 경로를 저장하면 공개 페이지가 깨진 이미지를 그린다.
 * 없으면 400 REFERENCE_NOT_FOUND (다른 FK 없는 참조와 같은 코드). http(s) URL은 외부라 확인하지 않는다.
 * 공지 썸네일과 하이라이트 이미지가 같은 규칙을 쓴다.
 */
export async function assertMediaPathExists(tx: Pick<DatabaseService, 'query'>, url: string | undefined | null): Promise<void> {
  if (!url || !isMediaPath(url)) return;
  const found = await tx.query<{ x: number }>(`SELECT 1 AS x FROM media_asset WHERE id = $1`, [url.slice('/media/'.length).toLowerCase()]);
  if (!found.rowCount) throw new BadRequestException('REFERENCE_NOT_FOUND');
}
