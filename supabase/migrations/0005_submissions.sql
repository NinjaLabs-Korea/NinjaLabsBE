-- ============================================================
-- 0005_submissions.sql — 제출 및 수정 이력 영역
-- ERD v1 §9 (bounty_submission, submission_revision,
--            submission_attachment, submission_review)
--
-- 정책: 제출자당 제출 레코드 1개(최신본) + revision 스냅샷 이력
-- ============================================================

CREATE TABLE bounty_submission (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id           UUID         NOT NULL REFERENCES bounty(id) ON DELETE CASCADE,
  application_id      UUID         REFERENCES bounty_application(id),
  submitter_user_id   UUID         REFERENCES "user"(id),
  agent_id            UUID,        -- FK는 0008에서 추가
  submission_url      TEXT         NOT NULL,
  description         TEXT         NOT NULL,
  repository_url      TEXT,
  commit_sha          VARCHAR(100),
  status              VARCHAR(30)  NOT NULL DEFAULT 'SUBMITTED'
                      CHECK (status IN ('SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  current_revision_no INTEGER      NOT NULL DEFAULT 1,
  submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_resubmitted_at TIMESTAMPTZ,
  reviewed_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_submission_actor CHECK (
    (submitter_user_id IS NOT NULL AND agent_id IS NULL)
    OR (submitter_user_id IS NULL AND agent_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_submission_user  ON bounty_submission(bounty_id, submitter_user_id) WHERE submitter_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_submission_agent ON bounty_submission(bounty_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_submission_bounty ON bounty_submission(bounty_id, status);

CREATE TRIGGER trg_submission_updated_at BEFORE UPDATE ON bounty_submission FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── submission_revision (제출/재제출 시점 스냅샷) ─────────
CREATE TABLE submission_revision (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       UUID         NOT NULL REFERENCES bounty_submission(id) ON DELETE CASCADE,
  revision_no         INTEGER      NOT NULL,
  submission_url      TEXT         NOT NULL,
  description         TEXT         NOT NULL,
  repository_url      TEXT,
  commit_sha          VARCHAR(100),
  change_reason       TEXT,
  created_by_user_id  UUID         REFERENCES "user"(id),
  created_by_agent_id UUID,        -- FK는 0008에서 추가
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (submission_id, revision_no)
);

-- ── submission_attachment ────────────────────────────────
CREATE TABLE submission_attachment (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID         NOT NULL REFERENCES bounty_submission(id) ON DELETE CASCADE,
  revision_id   UUID         REFERENCES submission_revision(id) ON DELETE SET NULL,
  file_name     VARCHAR(255) NOT NULL,
  file_url      TEXT         NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  file_size     BIGINT       NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_attachment_submission ON submission_attachment(submission_id);

-- ── submission_review (심사 이력) ─────────────────────────
CREATE TABLE submission_review (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID        NOT NULL REFERENCES bounty_submission(id) ON DELETE CASCADE,
  revision_id   UUID        REFERENCES submission_revision(id),
  reviewer_id   UUID        NOT NULL REFERENCES "user"(id),
  decision      VARCHAR(30) NOT NULL
                CHECK (decision IN ('START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT', 'REOPEN')),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_submission ON submission_review(submission_id);
