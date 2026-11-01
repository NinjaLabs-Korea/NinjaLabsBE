import { sqlColumnPrefix } from '../common/database/sql-alias';

/**
 * 공개 미디어 URL 모양의 단일 출처: 상대 경로 `/media/<uuid>`. FE는 `/media/:path*` rewrite로 같은 오리진에서 읽는다.
 * 업로드 응답(`POST /admin/media`, `POST /users/me/avatar`)과 프로필 사진 URL(`avatarUrl`/`avatar_url`)이 같은 모양이어야 한다.
 */
export function mediaPath(id: string): string {
  return `/media/${id}`;
}

/**
 * `mediaPath`의 SQL 판: media_asset id 컬럼을 `/media/<uuid>` 문자열로(NULL이면 NULL). 프로필 사진 URL을 읽는 쿼리
 * (`/auth/me`, `/users/:nickname`, `/members`)가 이것 하나를 쓴다.
 *
 * @param u 유저 테이블 별칭(빈 문자열이면 접두사 없이)
 */
export function avatarUrlSql(u = 'u'): string {
  const c = sqlColumnPrefix(u, 'avatarUrlSql');
  return `('/media/' || ${c}avatar_media_id::text)`;
}
