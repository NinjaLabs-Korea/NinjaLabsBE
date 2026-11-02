-- Only future INSERTs with no explicit id change. Never rename an existing on-chain
-- token or an explicitly restored legacy row. Stable business IDs must survive restore.
-- Supabase commonly installs pgcrypto in "extensions", not public. Bind its
-- actual schema at migration time rather than relying on the app search_path.
DO $migration$
DECLARE crypto_schema NAME;
BEGIN
SELECT n.nspname INTO STRICT crypto_schema FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
EXECUTE format($definition$
CREATE FUNCTION stable_nft_issuance_id(kind TEXT, business_id UUID) RETURNS UUID
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bytes BYTEA;
BEGIN
  -- UUIDv5, fixed project namespace; names and namespace are permanent protocol data.
  bytes := substring(%I.digest(decode('711f8f847cbf5107a96e3f3be23a82ab', 'hex') ||
    convert_to('NinjaLabs/nft/' || kind || '/v1/' || business_id::text, 'UTF8'), 'sha1') FROM 1 FOR 16);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 80);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END;
$$;
$definition$, crypto_schema);
END;
$migration$;
REVOKE ALL ON FUNCTION stable_nft_issuance_id(TEXT, UUID) FROM PUBLIC;

CREATE FUNCTION assign_stable_nft_issuance_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := stable_nft_issuance_id(
      CASE WHEN NEW.nft_type = 'NINJA_PARENT' THEN 'parent' ELSE 'child' END,
      CASE WHEN NEW.nft_type = 'NINJA_PARENT' THEN NEW.owner_user_id ELSE NEW.submission_id END);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION assign_stable_nft_issuance_id() FROM PUBLIC;
ALTER TABLE nft ALTER COLUMN id DROP DEFAULT;
CREATE TRIGGER trg_nft_stable_issuance_id BEFORE INSERT ON nft
  FOR EACH ROW EXECUTE FUNCTION assign_stable_nft_issuance_id();
