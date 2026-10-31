-- ============================================================
-- scripts/find-static-ext-nicknames.sql - 정적 파일 확장자로 끝나는 기존 ACTIVE 닉네임 목록 (읽기 전용)
--
--   psql "$DATABASE_URL" -X -f scripts/find-static-ext-nicknames.sql
--
-- 새 닉네임 규칙(src/users/nickname.ts STATIC_FILE_EXTENSIONS)은 `ninja.png`처럼 FE proxy가 정적 파일로 보는 확장자로 끝나는 닉네임을 거부한다.
-- 규칙 이전에 저장된 닉네임은 그대로 남아 있고 프로필 링크(`/users/<nickname>`)가 깨진다 - 배포 전에 이 목록을 뽑아 해당 유저에게 연락해 바꾸게 한다.
-- 자동으로 이름을 바꾸지 않는다 (docs/runbook.md §2 "닉네임 규칙 배포 전 점검").
-- 아래 정규식의 확장자 목록은 STATIC_FILE_EXTENSIONS(= NinjaLabsFE/src/proxy.ts matcher)와 같아야 한다 - src/test-db/ops-scripts.db-spec.ts가 검사한다.
-- 전체가 READ ONLY 트랜잭션 안에서 돌고 ROLLBACK한다.
-- ============================================================
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SELECT id, nickname, email, created_at
FROM "user"
WHERE status = 'ACTIVE'
  AND deleted_at IS NULL
  AND nickname ~* '\.(ico|png|jpg|jpeg|gif|svg|webp|avif|txt|xml|json|js|css|map|woff|woff2|ttf)$'
ORDER BY created_at;

ROLLBACK;
