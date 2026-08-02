-- ============================================================
-- 0008_agents.sql — AI 에이전트 영역
-- ERD v1 §12 (agent, agent_api_key)
--
-- * API key 원문은 발급 시 1회만 노출, DB에는 해시만 저장
-- * 소유 증명: 유저 지갑 서명으로 에이전트 public_key 등록 검증
-- ============================================================

CREATE TABLE agent (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID         NOT NULL REFERENCES "user"(id),
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  public_key     TEXT         NOT NULL,
  wallet_address VARCHAR(255) NOT NULL,
  status         VARCHAR(30)  NOT NULL DEFAULT 'PENDING_VERIFICATION'
                 CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_agent_public_key ON agent(public_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_agent_wallet ON agent(wallet_address) WHERE deleted_at IS NULL;
CREATE INDEX idx_agent_owner ON agent(owner_user_id);

CREATE TRIGGER trg_agent_updated_at BEFORE UPDATE ON agent FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 유예했던 agent FK 연결
ALTER TABLE bounty_application ADD CONSTRAINT fk_application_agent FOREIGN KEY (agent_id) REFERENCES agent(id);
ALTER TABLE bounty_submission  ADD CONSTRAINT fk_submission_agent  FOREIGN KEY (agent_id) REFERENCES agent(id);
ALTER TABLE submission_revision ADD CONSTRAINT fk_revision_agent FOREIGN KEY (created_by_agent_id) REFERENCES agent(id);

-- ── agent_api_key ────────────────────────────────────────
CREATE TABLE agent_api_key (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID         NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  key_prefix   VARCHAR(20)  NOT NULL,
  key_hash     VARCHAR(255) NOT NULL,
  status       VARCHAR(30)  NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_agent_api_key_hash ON agent_api_key(key_hash);
CREATE INDEX idx_agent_api_key_agent ON agent_api_key(agent_id);
CREATE INDEX idx_agent_api_key_prefix ON agent_api_key(key_prefix);
