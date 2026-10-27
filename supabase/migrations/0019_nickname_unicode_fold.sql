-- ============================================================
-- 0019_nickname_unicode_fold.sql: 닉네임 대소문자 유일성을 DB 로케일과 무관하게
--
-- uq_user_nickname_active 는 lower(nickname) 이었고 lower() 는 DB 의 lc_ctype 을 따른다. C 로케일이면 ASCII 만 접혀서
-- `café` 와 `CAFÉ`, `привет` 와 `ПРИВЕТ` 가 서로 다른 닉네임으로 둘 다 가입됐다. ICU collation 을 명시하면 lower() 가
-- DB 로케일을 보지 않고 유니코드 전체 대소문자 매핑을 쓴다.
--
-- 앱의 중복 검사·공개 프로필 조회(users/users.service.ts 의 NICKNAME_KEY_SQL)는 이 인덱스와 같은 식을 써야 한다.
-- 배포 전: 이미 활성 계정 사이에 새 식으로 충돌하는 쌍이 있으면 CREATE UNIQUE INDEX 가 23505 로 멈춘다
-- (scripts/mainnet-preflight.sql 11번이 미리 보여 준다).
-- ============================================================

DROP INDEX IF EXISTS uq_user_nickname_active;
CREATE UNIQUE INDEX uq_user_nickname_active ON "user" (lower(nickname COLLATE "und-x-icu")) WHERE deleted_at IS NULL;
