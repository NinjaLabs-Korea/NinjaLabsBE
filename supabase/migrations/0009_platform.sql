-- ============================================================
-- 0009_platform.sql — 감사 로그 / 플랫폼 설정
-- ERD v1 §13~14 (audit_log, platform_setting)
--
-- 주의: OAuth 토큰, refresh token 원문, private key, API key 원문,
--       KMS 민감 정보는 감사 로그에 절대 저장하지 않는다.
-- ============================================================

CREATE TABLE audit_log (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID         REFERENCES "user"(id),
  actor_agent_id UUID         REFERENCES agent(id),
  action         VARCHAR(100) NOT NULL,
  entity_type    VARCHAR(100) NOT NULL,
  entity_id      UUID,
  before_data    JSONB,
  after_data     JSONB,
  ip_address     INET,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ── platform_setting ─────────────────────────────────────
CREATE TABLE platform_setting (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB        NOT NULL,
  description TEXT,
  updated_by  UUID         REFERENCES "user"(id),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 초기 설정값
INSERT INTO platform_setting (key, value, description) VALUES
  ('recruitment.enabled',          'false'::jsonb, '신규 멤버 모집 오픈 여부'),
  ('onboarding.nft_mint_enabled',  'false'::jsonb, '가입 시 Ninja NFT 자동 민팅 여부 (컨트랙트 배포 전 false 유지)'),
  ('bounty.max_attachment_size',   '10485760'::jsonb, '첨부파일 최대 크기(바이트)');
