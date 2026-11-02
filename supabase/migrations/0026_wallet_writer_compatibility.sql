-- A feature flag cannot make an old writer safe. Keep these invariants in the DB
-- after the first replacement, even when HTTP binaries are rolled back.
ALTER TABLE "user" ADD COLUMN receiving_wallet_revision BIGINT NOT NULL DEFAULT 0
  CHECK (receiving_wallet_revision >= 0);

CREATE FUNCTION protect_replaced_wallet_payout() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_id UUID; revision BIGINT; target_id UUID;
BEGIN
  SELECT COALESCE(s.submitter_user_id, a.owner_user_id) INTO owner_id
    FROM bounty_submission s LEFT JOIN agent a ON a.id = s.agent_id
    WHERE s.id = NEW.submission_id;
  -- Separate statements are essential at READ COMMITTED: a joined legacy SELECT
  -- can wait for replacement while retaining its old wallet snapshot.
  SELECT receiving_wallet_revision INTO revision FROM "user"
    WHERE id = owner_id FOR SHARE;
  IF revision > 0 THEN
    SELECT id INTO target_id FROM wallet WHERE user_id = owner_id
      AND is_primary AND disconnected_at IS NULL AND verified_at IS NOT NULL;
    IF target_id IS NULL THEN
      RAISE EXCEPTION 'REPLACED_WALLET_RECIPIENT_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    NEW.recipient_wallet_id := target_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_replaced_wallet_payout() FROM PUBLIC;
CREATE TRIGGER trg_payout_receiving_wallet BEFORE INSERT ON payout
  FOR EACH ROW EXECUTE FUNCTION protect_replaced_wallet_payout();

CREATE FUNCTION protect_replaced_wallet_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision BIGINT; parent_id UUID; parent_wallet UUID;
BEGIN
  IF NEW.nft_type <> 'BOUNTY_COMPLETION_CHILD' THEN RETURN NEW; END IF;
  SELECT receiving_wallet_revision INTO revision FROM "user"
    WHERE id = NEW.owner_user_id FOR SHARE;
  IF revision > 0 THEN
    SELECT id, owner_wallet_id INTO parent_id, parent_wallet FROM nft
      WHERE owner_user_id = NEW.owner_user_id AND nft_type = 'NINJA_PARENT';
    IF NEW.parent_nft_id IS NOT NULL AND NEW.parent_nft_id IS DISTINCT FROM parent_id THEN
      RAISE EXCEPTION 'REPLACED_WALLET_PARENT_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF parent_id IS NOT NULL THEN
      NEW.parent_nft_id := parent_id;
      NEW.owner_wallet_id := parent_wallet;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_replaced_wallet_child() FROM PUBLIC;
CREATE TRIGGER trg_nft_receiving_wallet BEFORE INSERT ON nft
  FOR EACH ROW EXECUTE FUNCTION protect_replaced_wallet_child();
