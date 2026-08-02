-- ============================================================
-- 0002_wallets.sql — 지갑 영역
-- ERD v1 §4 (wallet, wallet_verification_challenge)
--
-- 설계 메모
-- * MVP는 사용자당 단일 지갑이지만, 지갑 교체/멀티월렛 확장 대비 별도 테이블
-- * 사용자당 활성 대표 지갑은 부분 유니크 인덱스로 1개 강제
-- * nonce는 1회용 + 짧은 만료. used_at 기록 후 재사용 금지
-- ============================================================

CREATE TABLE wallet (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chain           VARCHAR(30)  NOT NULL DEFAULT 'INJECTIVE'
                  CHECK (chain IN ('INJECTIVE', 'ETHEREUM', 'SOLANA', 'COSMOS')),
  address         VARCHAR(255) NOT NULL,
  public_key      TEXT,
  is_primary      BOOLEAN      NOT NULL DEFAULT true,
  verified_at     TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 동일 체인의 동일 주소는 플랫폼 전체에서 1개 (연결 해제된 지갑 제외)
CREATE UNIQUE INDEX uq_wallet_chain_address_active
  ON wallet(chain, address) WHERE disconnected_at IS NULL;

-- 사용자당 활성 대표 지갑 1개
CREATE UNIQUE INDEX uq_wallet_primary_per_user
  ON wallet(user_id) WHERE is_primary = true AND disconnected_at IS NULL;

CREATE INDEX idx_wallet_user ON wallet(user_id);

CREATE TRIGGER trg_wallet_updated_at BEFORE UPDATE ON wallet FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── wallet_verification_challenge ────────────────────────
CREATE TABLE wallet_verification_challenge (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  wallet_address VARCHAR(255) NOT NULL,
  nonce          VARCHAR(255) NOT NULL,
  message        TEXT         NOT NULL,
  expires_at     TIMESTAMPTZ  NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_wvc_user ON wallet_verification_challenge(user_id);
CREATE INDEX idx_wvc_address ON wallet_verification_challenge(wallet_address);
