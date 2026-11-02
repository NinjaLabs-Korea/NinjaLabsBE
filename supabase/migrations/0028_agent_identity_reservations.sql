-- Cross-version invariant: old binaries compare raw strings and can miss a
-- verified REVOKED identity's aliases. Persist its owner independently of status.
-- Block writes until preflight, backfill and triggers have committed together.
LOCK TABLE agent IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (
    WITH identities AS (
      SELECT owner_user_id, status, verified_at, unnest(ARRAY[
        'account:' || COALESCE(agent_account_key(wallet_address),wallet_address),
        'key:' || COALESCE(agent_public_key_id(public_key),public_key)
      ]) AS identity FROM agent WHERE deleted_at IS NULL
    )
    SELECT 1 FROM identities WHERE identity IS NOT NULL GROUP BY identity
      HAVING count(DISTINCT owner_user_id) FILTER (WHERE verified_at IS NOT NULL) > 1
        OR min(owner_user_id::text) FILTER (WHERE verified_at IS NOT NULL) <> max(owner_user_id::text) FILTER (WHERE status <> 'REVOKED')
        OR max(owner_user_id::text) FILTER (WHERE verified_at IS NOT NULL) <> min(owner_user_id::text) FILTER (WHERE status <> 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'AGENT_CANONICAL_RESERVATION_CONFLICT: run node scripts/check-agent-identities.js; resolve ownership before deployment, no owner is chosen automatically';
  END IF;
END $$;

CREATE TABLE agent_identity_reservation (
  identity TEXT PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_identity_reservation ENABLE ROW LEVEL SECURITY;

INSERT INTO agent_identity_reservation (identity, owner_user_id)
SELECT DISTINCT identity, owner_user_id FROM (
  SELECT owner_user_id, unnest(ARRAY[
    'account:' || COALESCE(agent_account_key(wallet_address),wallet_address),
    'key:' || COALESCE(agent_public_key_id(public_key),public_key)
  ]) AS identity FROM agent WHERE deleted_at IS NULL AND verified_at IS NOT NULL
) verified WHERE identity IS NOT NULL;

CREATE FUNCTION protect_agent_identity_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE identity_key TEXT; reserved_owner UUID;
BEGIN
  -- Unverified revoked/deleted rows must remain cleanable and never squat keys.
  IF NEW.deleted_at IS NOT NULL OR (NEW.status = 'REVOKED' AND NEW.verified_at IS NULL) THEN RETURN NEW; END IF;
  FOR identity_key IN
    SELECT value FROM unnest(ARRAY[
      'account:' || COALESCE(agent_account_key(NEW.wallet_address),NEW.wallet_address),
      'key:' || COALESCE(agent_public_key_id(NEW.public_key),NEW.public_key)
    ]) value WHERE value IS NOT NULL ORDER BY value
  LOOP
    IF NEW.verified_at IS NOT NULL THEN
      -- Only a successful proof reserves ownership. Unique-key waits serialize
      -- competing claims; the next statement reads the committed owner afresh.
      INSERT INTO agent_identity_reservation (identity, owner_user_id)
        VALUES (identity_key, NEW.owner_user_id) ON CONFLICT (identity) DO NOTHING;
    END IF;
    SELECT owner_user_id INTO reserved_owner FROM agent_identity_reservation WHERE identity = identity_key;
    IF FOUND AND reserved_owner <> NEW.owner_user_id THEN
      -- Both old register and old verify already map this named 23505 to 409.
      RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'uq_agent_public_key',
        MESSAGE = 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_agent_identity_reservation() FROM PUBLIC;
CREATE TRIGGER trg_agent_identity_reservation
  BEFORE INSERT OR UPDATE OF owner_user_id, wallet_address, public_key, status, verified_at, deleted_at ON agent
  FOR EACH ROW EXECUTE FUNCTION protect_agent_identity_reservation();
-- An old INSERT may wait on the live canonical index while a peer verifies and
-- revokes its row. Recheck AFTER that wait on a fresh READ COMMITTED snapshot.
CREATE TRIGGER trg_agent_identity_reservation_after
  AFTER INSERT OR UPDATE OF owner_user_id, wallet_address, public_key, status, verified_at, deleted_at ON agent
  FOR EACH ROW EXECUTE FUNCTION protect_agent_identity_reservation();
