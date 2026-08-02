-- ============================================================
-- 0001_users.sql — 사용자 / 인증 영역
-- ERD v1 §3 (user, user_tag, user_link, auth_session)
--
-- 설계 메모
-- * 상태값은 PG enum 대신 VARCHAR + CHECK 사용 (값 추가/변경 시 ALTER가 쉬움)
-- * "user"는 PG 예약어라 항상 따옴표로 감싼다. 애플리케이션에서는 users 별칭 사용 가능
-- * onboarding_completed는 별도 boolean 없이 onboarding_completed_at IS NOT NULL로 판단
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── user ─────────────────────────────────────────────────
CREATE TABLE "user" (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id                VARCHAR(255) NOT NULL,
  email                    VARCHAR(320) NOT NULL,
  nickname                 VARCHAR(50)  NOT NULL,
  bio                      TEXT         NOT NULL DEFAULT '',
  onboarding_step          SMALLINT     NOT NULL DEFAULT 1,
  onboarding_completed_at  TIMESTAMPTZ,
  status                   VARCHAR(30)  NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWN')),
  is_admin                 BOOLEAN      NOT NULL DEFAULT false,
  is_member                BOOLEAN      NOT NULL DEFAULT false,
  member_role              VARCHAR(30)
                           CHECK (member_role IN ('CORE', 'DEV', 'DESIGN', 'OPS')),
  member_display_order     INTEGER,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_user_google_id ON "user"(google_id);
CREATE UNIQUE INDEX uq_user_email     ON "user"(email);
-- 닉네임은 탈퇴(soft delete)한 유저와는 충돌하지 않도록 활성 유저 기준 유니크
CREATE UNIQUE INDEX uq_user_nickname_active ON "user"(lower(nickname)) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_is_member ON "user"(is_member) WHERE is_member = true;

-- ── user_tag ─────────────────────────────────────────────
CREATE TABLE user_tag (
  user_id    UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  tag        VARCHAR(30) NOT NULL
             CHECK (tag IN ('DEV', 'DESIGN', 'CONTENT', 'OTHER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tag)
);

-- ── user_link ────────────────────────────────────────────
CREATE TABLE user_link (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  link_type     VARCHAR(30) NOT NULL
                CHECK (link_type IN ('GITHUB', 'X', 'TELEGRAM', 'LINKEDIN', 'PORTFOLIO', 'WEBSITE', 'OTHER')),
  url           TEXT        NOT NULL,
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_link_user ON user_link(user_id);

-- ── auth_session ─────────────────────────────────────────
-- refresh token은 원문 저장 금지, 해시만 저장
CREATE TABLE auth_session (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID         NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  ip_address         INET,
  user_agent         TEXT,
  expires_at         TIMESTAMPTZ  NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_session_user ON auth_session(user_id);
CREATE INDEX idx_auth_session_token ON auth_session(refresh_token_hash);

-- ── updated_at 자동 갱신 트리거 (전 테이블 공용 함수) ─────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_updated_at      BEFORE UPDATE ON "user"    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_link_updated_at BEFORE UPDATE ON user_link FOR EACH ROW EXECUTE FUNCTION set_updated_at();
