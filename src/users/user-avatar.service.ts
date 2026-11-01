import { Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { mediaPath } from '../media/media-path';
import { insertImageAsset, MAX_AVATAR_BYTES, UploadedImage } from '../media/media.service';
import { clearAvatarOfUser, deleteAvatarAsset } from './user-avatar';

export type AvatarResponse = { avatarUrl: string | null };

/**
 * 회원 본인의 프로필 사진 (POST/DELETE /users/me/avatar). 이미지 검증·저장은 media 모듈 규칙(insertImageAsset) 그대로이고
 * 상한만 MAX_AVATAR_BYTES(2 MiB)다. 프로필 저장처럼 온보딩 단계와 무관하게 로그인한 활성 회원이면 된다.
 *
 * 한 트랜잭션: 유저 행 잠금 -> 새 이미지 INSERT -> avatar_media_id 교체 -> 옛 이미지 행 삭제 -> 감사.
 * 잠금이 같은 유저의 동시 업로드 두 건과 탈퇴를 직렬화한다 (탈퇴가 먼저 커밋됐으면 0행이라 404 USER_NOT_FOUND, 새 이미지도 롤백).
 */
@Injectable()
export class UserAvatarService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async replace(userId: string, file: UploadedImage | undefined): Promise<AvatarResponse> {
    return this.db.tx(async (tx) => {
      const previous = await this.lockUser(tx, userId);
      const created = await insertImageAsset(tx, userId, file, MAX_AVATAR_BYTES);
      await tx.query(`UPDATE "user" SET avatar_media_id = $2::uuid WHERE id = $1::uuid`, [userId, created.id]);
      await deleteAvatarAsset(tx, userId, previous);
      await this.audit.record(userId, 'USER_AVATAR_UPDATED', 'user', userId, tx, {
        before: { avatarMediaId: previous },
        after: { avatarMediaId: created.id },
      });
      return { avatarUrl: mediaPath(created.id) };
    });
  }

  /** 멱등: 사진이 없으면 아무것도 바꾸지 않고(감사 행도 없이) 같은 응답 */
  async remove(userId: string): Promise<AvatarResponse> {
    return this.db.tx(async (tx) => {
      await this.lockUser(tx, userId);
      const removed = await clearAvatarOfUser(tx, userId);
      if (removed) {
        await this.audit.record(userId, 'USER_AVATAR_REMOVED', 'user', userId, tx, {
          before: { avatarMediaId: removed },
          after: { avatarMediaId: null },
        });
      }
      return { avatarUrl: null };
    });
  }

  /** 탈퇴하지 않은 유저 행을 잠그고 지금 사진의 media id를 돌려준다 */
  private async lockUser(tx: PoolClient, userId: string): Promise<string | null> {
    const current = await tx.query<{ avatar_media_id: string | null }>(
      `SELECT avatar_media_id FROM "user" WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
      [userId],
    );
    if (!current.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    return current.rows[0].avatar_media_id;
  }
}
