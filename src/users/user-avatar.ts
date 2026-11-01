import { QueryRunner } from '../common/database/database.service';

/**
 * 프로필 사진 행 정리의 단일 출처 - 사진 교체·삭제(user-avatar.service.ts)와 회원 탈퇴(account-withdrawal.service.ts)가
 * 자기 트랜잭션 안에서 부른다. 호출부는 이미 그 유저 행을 `FOR UPDATE`로 잠근 상태여야 한다.
 *
 * 옛 media_asset 행을 지우는 이유: 사진을 지우거나 탈퇴한 사람의 얼굴이 `/media/<uuid>`로 계속 열리면 안 된다.
 * `created_by = 유저` 조건을 함께 건다 - 이 컬럼이 가리키는 행은 회원 업로드(POST /users/me/avatar)로만 생기지만,
 * 혹시 운영 SQL로 어드민 이미지를 가리키게 됐더라도 남의 이미지를 지우지 않는다.
 * 이미 받아 간 브라우저·CDN 캐시(immutable, 1년)는 지울 수 없다 (wiki be/media "함정").
 */
export async function deleteAvatarAsset(tx: QueryRunner, userId: string, mediaId: string | null): Promise<void> {
  if (!mediaId) return;
  await tx.query(
    `DELETE FROM media_asset WHERE id = $1::uuid AND created_by = $2::uuid`,
    [mediaId, userId],
  );
}

/**
 * 유저의 프로필 사진을 비우고 옛 media_asset 행을 지운다. 지운 사진의 media id(없었으면 null)를 돌려준다.
 * 잠금은 호출부 책임(위 설명). 탈퇴는 감사 `USER_WITHDRAWN` 하나로 충분해 여기서 감사 행을 쓰지 않는다.
 */
export async function clearAvatarOfUser(tx: QueryRunner, userId: string): Promise<string | null> {
  const previous = (await tx.query(
    `SELECT avatar_media_id FROM "user" WHERE id = $1::uuid`,
    [userId],
  )) as { rows: Array<{ avatar_media_id: string | null }> };
  const mediaId = previous.rows[0]?.avatar_media_id ?? null;
  if (!mediaId) return null;
  await tx.query(`UPDATE "user" SET avatar_media_id = NULL WHERE id = $1::uuid`, [userId]);
  await deleteAvatarAsset(tx, userId, mediaId);
  return mediaId;
}
