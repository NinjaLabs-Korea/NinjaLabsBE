-- Preserve signing addresses/schemes and historical rows. Compare account/key bytes,
-- not EVM/bech32 or hex/base64 spelling. Old code recognizes these index names too.
CREATE FUNCTION agent_account_key(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  address text := btrim(value);
  alphabet constant text := 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  generators constant bigint[] := ARRAY[996825010,642813549,513874426,1027748829,705979059]::bigint[];
  values5 integer[] := ARRAY[3,3,3,0,9,14,10]; -- bech32 expanded "inj"
  chk bigint := 1;
  top bigint;
  v integer;
  acc integer := 0;
  bits integer := 0;
  result text := '';
BEGIN
  IF address ~* '^0x[0-9a-f]{40}$' THEN RETURN lower(address); END IF;
  IF address <> lower(address) AND address <> upper(address) THEN RETURN NULL; END IF;
  address := lower(address);
  IF length(address) <> 42 OR left(address,4) <> 'inj1' THEN RETURN NULL; END IF;
  FOR i IN 5..42 LOOP
    v := strpos(alphabet, substr(address,i,1)) - 1;
    IF v < 0 THEN RETURN NULL; END IF;
    values5 := array_append(values5,v);
    IF i <= 36 THEN
      acc := (acc << 5) | v;
      bits := bits + 5;
      IF bits >= 8 THEN
        bits := bits - 8;
        result := result || lpad(to_hex((acc >> bits) & 255),2,'0');
        acc := acc & ((1 << bits) - 1);
      END IF;
    END IF;
  END LOOP;
  FOREACH v IN ARRAY values5 LOOP
    top := chk >> 25;
    chk := ((chk & 33554431) << 5) # v;
    FOR j IN 0..4 LOOP
      IF ((top >> j) & 1) = 1 THEN chk := chk # generators[j+1]; END IF;
    END LOOP;
  END LOOP;
  IF chk <> 1 OR bits <> 0 OR length(result) <> 40 THEN RETURN NULL; END IF;
  RETURN '0x' || result;
END $$;

CREATE FUNCTION agent_public_key_id(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE key_bytes bytea;
BEGIN
  IF value ~* '^0x0[23][0-9a-f]{64}$' THEN RETURN lower(substr(value,3)); END IF;
  BEGIN key_bytes := decode(value,'base64'); EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  IF octet_length(key_bytes) <> 33 OR get_byte(key_bytes,0) NOT IN (2,3) THEN RETURN NULL; END IF;
  RETURN encode(key_bytes,'hex');
END $$;

-- Internal index helpers, not public Supabase RPC endpoints. The DB/migration owner
-- retains execution rights; custom non-owner backend roles need an explicit scoped grant.
REVOKE ALL ON FUNCTION agent_account_key(text), agent_public_key_id(text) FROM PUBLIC;

-- Fail closed, never choose an owner or delete history during preDeploy. The runner
-- rolls this file back, leaving the previously deployed code/schema intact.
DO $$ BEGIN
  IF EXISTS (
    WITH identities AS (
      SELECT owner_user_id, status, verified_at, unnest(ARRAY[
        'account:' || COALESCE(agent_account_key(wallet_address),wallet_address),
        'key:' || COALESCE(agent_public_key_id(public_key),public_key)
      ]) AS identity FROM agent WHERE deleted_at IS NULL
    )
    SELECT 1 FROM identities WHERE identity IS NOT NULL GROUP BY identity
      HAVING count(*) FILTER (WHERE status <> 'REVOKED') > 1
        OR min(owner_user_id::text) FILTER (WHERE verified_at IS NOT NULL) <> max(owner_user_id::text) FILTER (WHERE status <> 'REVOKED')
        OR max(owner_user_id::text) FILTER (WHERE verified_at IS NOT NULL) <> min(owner_user_id::text) FILTER (WHERE status <> 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'AGENT_CANONICAL_IDENTITY_CONFLICT: run node scripts/check-agent-identities.js and resolve verified ownership conflicts before deploying; no rows were changed';
  END IF;
END $$;

DROP INDEX uq_agent_wallet;
CREATE UNIQUE INDEX uq_agent_wallet ON agent((COALESCE(agent_account_key(wallet_address),wallet_address)))
  WHERE deleted_at IS NULL AND status <> 'REVOKED';
DROP INDEX uq_agent_public_key;
CREATE UNIQUE INDEX uq_agent_public_key ON agent((COALESCE(agent_public_key_id(public_key),public_key)))
  WHERE deleted_at IS NULL AND status <> 'REVOKED';

-- Reservation lookups also include REVOKED history; do not scan/decode every account per registration.
CREATE INDEX idx_agent_account_reservations ON agent((COALESCE(agent_account_key(wallet_address),wallet_address))) WHERE deleted_at IS NULL;
CREATE INDEX idx_agent_key_reservations ON agent((COALESCE(agent_public_key_id(public_key),public_key))) WHERE deleted_at IS NULL AND public_key IS NOT NULL;
