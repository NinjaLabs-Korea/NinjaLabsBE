-- Purpose-bound, dual-signature authorizations. Signatures are never stored.
CREATE TABLE wallet_replacement_challenge (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES "user"(id),
  current_wallet_id UUID NOT NULL REFERENCES wallet(id),
  current_signing_address VARCHAR(255) NOT NULL,
  new_signing_address VARCHAR(255) NOT NULL,
  new_address VARCHAR(255) NOT NULL,
  current_message TEXT NOT NULL,
  new_message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  new_wallet_id UUID REFERENCES wallet(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((completed_at IS NULL) = (new_wallet_id IS NULL))
);
CREATE UNIQUE INDEX uq_wallet_replacement_open
  ON wallet_replacement_challenge(user_id) WHERE completed_at IS NULL;
CREATE INDEX idx_wallet_replacement_expiry ON wallet_replacement_challenge(expires_at);
ALTER TABLE wallet_replacement_challenge ENABLE ROW LEVEL SECURITY;
