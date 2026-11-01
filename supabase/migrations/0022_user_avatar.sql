-- ============================================================
-- 0022_user_avatar.sql: 회원 프로필 사진
--
--   "user".avatar_media_id   프로필 사진 media_asset 행 (NULL = 사진 없음, FE는 이니셜을 그린다).
--                            회원이 POST /users/me/avatar 로 올린 행만 가리킨다 (어드민 업로드 행을 가리키지 않는다).
--                            사진을 바꾸거나 지우거나 탈퇴하면 BE가 같은 트랜잭션에서 옛 media_asset 행을 지운다(users/user-avatar.ts).
--   ON DELETE SET NULL       media_asset 행이 운영 SQL 등으로 지워져도 유저 행이 깨지지 않고 "사진 없음"이 된다.
--   idx_user_avatar_media    media_asset 행 삭제 때 FK 역참조 검사가 "user" 전체를 훑지 않게 하는 부분 인덱스.
--
-- 비파괴 변경: NULL 허용 새 컬럼 하나 + 인덱스 하나. 기존 행은 전부 NULL(사진 없음)이다. 새 테이블이 없어 RLS 변경도 없다.
-- ============================================================

ALTER TABLE "user" ADD COLUMN avatar_media_id UUID REFERENCES media_asset(id) ON DELETE SET NULL;

CREATE INDEX idx_user_avatar_media ON "user"(avatar_media_id) WHERE avatar_media_id IS NOT NULL;
