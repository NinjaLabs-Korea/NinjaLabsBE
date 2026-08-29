-- Persist admin-uploaded images and replace frontend-derived bounty metadata.

CREATE TABLE media_asset (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID         NOT NULL REFERENCES "user"(id),
  file_name     VARCHAR(255) NOT NULL,
  mime_type     VARCHAR(100) NOT NULL
                CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size     INTEGER      NOT NULL CHECK (file_size > 0 AND file_size <= 5242880),
  sha256        CHAR(64)     NOT NULL,
  data          BYTEA        NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_asset_created_at ON media_asset(created_at DESC);

ALTER TABLE bounty
  ADD COLUMN cover_image_url TEXT,
  ADD COLUMN submission_mode VARCHAR(20) NOT NULL DEFAULT 'DIRECT'
    CHECK (submission_mode IN ('DIRECT', 'AGENT'));
