-- ============================================================
-- 0007_nfts.sql — NFT 영역
-- ERD v1 §11 (nft, nft_job)
--
-- * Ninja 부모 NFT: 가입한 모든 유저 대상, 지갑 연결 시 민팅 시도
-- * 바운티 완료 자식 NFT: 승인 시 발급 후 부모에 attach
-- * 온체인 작업은 API 안에서 실행하지 않고 nft_job 큐로 비동기 처리
-- ============================================================

CREATE TABLE nft (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    UUID         NOT NULL REFERENCES "user"(id),
  owner_wallet_id  UUID         NOT NULL REFERENCES wallet(id),
  parent_nft_id    UUID         REFERENCES nft(id),
  bounty_id        UUID         REFERENCES bounty(id),
  submission_id    UUID         REFERENCES bounty_submission(id),
  nft_type         VARCHAR(40)  NOT NULL
                   CHECK (nft_type IN ('NINJA_PARENT', 'BOUNTY_COMPLETION_CHILD')),
  contract_address VARCHAR(255) NOT NULL,
  token_id         VARCHAR(255),
  metadata_uri     TEXT,
  status           VARCHAR(30)  NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'MINTING', 'MINTED', 'ATTACHING', 'ATTACHED', 'FAILED')),
  mint_tx_hash     VARCHAR(255),
  attach_tx_hash   VARCHAR(255),
  minted_at        TIMESTAMPTZ,
  attached_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- 자식 NFT는 반드시 바운티/제출물과 연결
  CONSTRAINT chk_nft_child_refs CHECK (
    nft_type <> 'BOUNTY_COMPLETION_CHILD'
    OR (bounty_id IS NOT NULL AND submission_id IS NOT NULL)
  )
);

-- 사용자당 Ninja 부모 NFT 1개
CREATE UNIQUE INDEX uq_nft_parent_per_user
  ON nft(owner_user_id) WHERE nft_type = 'NINJA_PARENT';

-- 제출물당 완료 NFT 1개
CREATE UNIQUE INDEX uq_nft_child_per_submission
  ON nft(submission_id) WHERE nft_type = 'BOUNTY_COMPLETION_CHILD';

CREATE INDEX idx_nft_owner ON nft(owner_user_id);
CREATE INDEX idx_nft_status ON nft(status);

CREATE TRIGGER trg_nft_updated_at BEFORE UPDATE ON nft FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── nft_job (민팅/attach 비동기 작업 큐) ──────────────────
CREATE TABLE nft_job (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  nft_id          UUID         NOT NULL REFERENCES nft(id) ON DELETE CASCADE,
  job_type        VARCHAR(30)  NOT NULL
                  CHECK (job_type IN ('MINT_PARENT', 'MINT_CHILD', 'ATTACH_CHILD', 'RETRY_MINT', 'RETRY_ATTACH')),
  idempotency_key VARCHAR(255) NOT NULL,
  status          VARCHAR(30)  NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  retry_count     INTEGER      NOT NULL DEFAULT 0,
  last_error      TEXT,
  scheduled_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_nft_job_idempotency ON nft_job(idempotency_key);
-- 워커 폴링용: 처리 대기 중인 잡
CREATE INDEX idx_nft_job_pending ON nft_job(scheduled_at) WHERE status = 'PENDING';

CREATE TRIGGER trg_nft_job_updated_at BEFORE UPDATE ON nft_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();
