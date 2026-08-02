-- ============================================================
-- 0006_rewards.sql — 보상 영역
-- ERD v1 §10 (bounty_reward, payout)
--
-- MVP 보상 정책: 스폰서 선입금 → 멀티시그 보관 → 심사 → payout
-- 금액은 부동소수점 금지, 토큰 최소 단위 정수(DECIMAL(78,0)) 저장
--   예) 1 INJ = 10^18
-- ============================================================

CREATE TABLE bounty_reward (
  id                     UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id              UUID           NOT NULL REFERENCES bounty(id) ON DELETE CASCADE,
  chain                  VARCHAR(30)    NOT NULL DEFAULT 'INJECTIVE',
  token_type             VARCHAR(30)    NOT NULL CHECK (token_type IN ('NATIVE', 'CW20')),
  token_denom            VARCHAR(255),
  token_contract_address VARCHAR(255),
  display_symbol         VARCHAR(30)    NOT NULL,
  amount                 DECIMAL(78,0)  NOT NULL CHECK (amount > 0),
  custody_type           VARCHAR(30)    NOT NULL DEFAULT 'MULTISIG'
                         CHECK (custody_type IN ('MULTISIG', 'ESCROW_CONTRACT')),
  custody_address        VARCHAR(255)   NOT NULL,
  deposit_tx_hash        VARCHAR(255),
  deposited_amount       DECIMAL(78,0)  NOT NULL DEFAULT 0,
  status                 VARCHAR(30)    NOT NULL DEFAULT 'DEPOSIT_PENDING'
                         CHECK (status IN ('DEPOSIT_PENDING', 'FUNDED', 'PARTIALLY_PAID', 'PAID', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED')),
  deposited_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- 토큰 유형별 필수 필드
  CONSTRAINT chk_reward_token CHECK (
    (token_type = 'NATIVE' AND token_denom IS NOT NULL)
    OR (token_type = 'CW20' AND token_contract_address IS NOT NULL)
  )
);

CREATE INDEX idx_reward_bounty ON bounty_reward(bounty_id);

CREATE TRIGGER trg_reward_updated_at BEFORE UPDATE ON bounty_reward FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── payout ───────────────────────────────────────────────
CREATE TABLE payout (
  id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_reward_id    UUID           NOT NULL REFERENCES bounty_reward(id),
  submission_id       UUID           NOT NULL REFERENCES bounty_submission(id),
  recipient_wallet_id UUID           NOT NULL REFERENCES wallet(id),
  amount              DECIMAL(78,0)  NOT NULL CHECK (amount > 0),
  status              VARCHAR(30)    NOT NULL DEFAULT 'REQUESTED'
                      CHECK (status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'PAID', 'FAILED', 'CANCELLED')),
  idempotency_key     VARCHAR(255)   NOT NULL,
  requested_by        UUID           NOT NULL REFERENCES "user"(id),
  approved_by         UUID           REFERENCES "user"(id),
  payout_tx_hash      VARCHAR(255),
  retry_count         INTEGER        NOT NULL DEFAULT 0,
  last_error          TEXT,
  requested_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  approved_at         TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- 중복 지급 방지: bounty:{id}:submission:{id}:reward:{id}
CREATE UNIQUE INDEX uq_payout_idempotency ON payout(idempotency_key);
CREATE INDEX idx_payout_reward ON payout(bounty_reward_id);
CREATE INDEX idx_payout_status ON payout(status);

CREATE TRIGGER trg_payout_updated_at BEFORE UPDATE ON payout FOR EACH ROW EXECUTE FUNCTION set_updated_at();
