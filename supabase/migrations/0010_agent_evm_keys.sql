-- EVM agent keys reveal their secp256k1 public key only after the
-- registration message is signed. ADR-36 registrations still provide it up front.
ALTER TABLE agent ALTER COLUMN public_key DROP NOT NULL;
