-- ============================================================
-- 0004_bounties.sql — 바운티 영역
-- ERD v1 §7~8 (bounty, bounty_attachment, bounty_application)
--
-- 상태 흐름:
--   DRAFT → FUNDING_PENDING → OPEN → SUBMISSION_CLOSED → IN_REVIEW → COMPLETED
--   취소: DRAFT/FUNDING_PENDING/OPEN → CANCELLED
-- ============================================================

CREATE TABLE bounty (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by            UUID         NOT NULL REFERENCES "user"(id),
  sponsor_user_id       UUID         REFERENCES "user"(id),
  sponsor_name          VARCHAR(100) NOT NULL,
  title                 VARCHAR(200) NOT NULL,
  summary               TEXT         NOT NULL,
  description           TEXT         NOT NULL,
  requirements          TEXT         NOT NULL,
  evaluation_criteria   TEXT         NOT NULL,
  category              VARCHAR(30)  NOT NULL
                        CHECK (category IN ('DEV', 'DESIGN', 'CONTENT', 'OTHER')),
  status                VARCHAR(30)  NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED')),
  application_required  BOOLEAN      NOT NULL DEFAULT false,
  max_winners           INTEGER      NOT NULL DEFAULT 1 CHECK (max_winners >= 1),
  application_deadline  TIMESTAMPTZ,
  submission_deadline   TIMESTAMPTZ  NOT NULL,
  opened_at             TIMESTAMPTZ,
  review_started_at     TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX idx_bounty_status ON bounty(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_bounty_open ON bounty(submission_deadline) WHERE status = 'OPEN' AND deleted_at IS NULL;

CREATE TRIGGER trg_bounty_updated_at BEFORE UPDATE ON bounty FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- platform_highlight.bounty_id FK 연결 (0003에서 유예)
ALTER TABLE platform_highlight
  ADD CONSTRAINT fk_highlight_bounty FOREIGN KEY (bounty_id) REFERENCES bounty(id) ON DELETE SET NULL;

-- ── bounty_attachment ────────────────────────────────────
CREATE TABLE bounty_attachment (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id     UUID         NOT NULL REFERENCES bounty(id) ON DELETE CASCADE,
  file_name     VARCHAR(255) NOT NULL,
  file_url      TEXT         NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  file_size     BIGINT       NOT NULL,
  display_order INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_bounty_attachment_bounty ON bounty_attachment(bounty_id);

-- ── bounty_application (지원형 바운티 참가 신청) ──────────
CREATE TABLE bounty_application (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id         UUID        NOT NULL REFERENCES bounty(id) ON DELETE CASCADE,
  applicant_user_id UUID        REFERENCES "user"(id),
  agent_id          UUID,       -- FK는 0008에서 agent 생성 후 추가
  message           TEXT        NOT NULL,
  portfolio_url     TEXT,
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  reviewed_by       UUID        REFERENCES "user"(id),
  review_note       TEXT,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 지원 주체는 사용자 또는 에이전트 중 정확히 하나
  CONSTRAINT chk_application_actor CHECK (
    (applicant_user_id IS NOT NULL AND agent_id IS NULL)
    OR (applicant_user_id IS NULL AND agent_id IS NOT NULL)
  )
);

-- 같은 바운티에 사용자/에이전트 각각 1회만 지원
CREATE UNIQUE INDEX uq_application_user  ON bounty_application(bounty_id, applicant_user_id) WHERE applicant_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_application_agent ON bounty_application(bounty_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_application_bounty ON bounty_application(bounty_id, status);

CREATE TRIGGER trg_application_updated_at BEFORE UPDATE ON bounty_application FOR EACH ROW EXECUTE FUNCTION set_updated_at();
