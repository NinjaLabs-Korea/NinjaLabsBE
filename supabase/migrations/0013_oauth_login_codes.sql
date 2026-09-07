-- Browser-bound, single-use login handoff. Raw codes and session tokens are never stored here.
CREATE TABLE oauth_login_code (
  code_hash      CHAR(64) PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  code_challenge VARCHAR(43) NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '60 seconds'
);

CREATE INDEX idx_oauth_login_code_expiry ON oauth_login_code(expires_at);
ALTER TABLE oauth_login_code ENABLE ROW LEVEL SECURITY;
