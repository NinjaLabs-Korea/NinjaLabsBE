-- ============================================================
-- 0003_content.sql — 커뮤니티 콘텐츠 영역
-- ERD v1 §5~6 (notice, notice_tag, platform_highlight)
-- ============================================================

-- ── notice ───────────────────────────────────────────────
CREATE TABLE notice (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID         NOT NULL REFERENCES "user"(id),
  title         VARCHAR(200) NOT NULL,
  summary       TEXT,
  body          TEXT         NOT NULL,
  category      VARCHAR(50)  NOT NULL DEFAULT 'NINJALABS'
                CHECK (category IN ('NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER')),
  thumbnail_url TEXT,
  external_url  TEXT,
  status        VARCHAR(30)  NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_notice_published
  ON notice(published_at DESC) WHERE status = 'PUBLISHED' AND deleted_at IS NULL;

CREATE TRIGGER trg_notice_updated_at BEFORE UPDATE ON notice FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── notice_tag ───────────────────────────────────────────
CREATE TABLE notice_tag (
  notice_id  UUID        NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  tag        VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, tag)
);

-- ── platform_highlight (Hall of Fame 큐레이션) ────────────
CREATE TABLE platform_highlight (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID         NOT NULL REFERENCES "user"(id),
  bounty_id     UUID,        -- FK는 0004에서 bounty 생성 후 추가
  type          VARCHAR(30)  NOT NULL
                CHECK (type IN ('MILESTONE', 'FEATURED_BOUNTY', 'PROJECT', 'PARTNERSHIP', 'AWARD', 'OTHER')),
  title         VARCHAR(200) NOT NULL,
  description   TEXT         NOT NULL,
  image_url     TEXT,
  link_url      TEXT,
  display_order INTEGER      NOT NULL DEFAULT 0,
  is_published  BOOLEAN      NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_highlight_published
  ON platform_highlight(display_order) WHERE is_published = true;

CREATE TRIGGER trg_highlight_updated_at BEFORE UPDATE ON platform_highlight FOR EACH ROW EXECUTE FUNCTION set_updated_at();
