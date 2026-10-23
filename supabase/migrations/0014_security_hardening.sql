-- ============================================================
-- 0014_security_hardening.sql — 보안 점검 후속 (docs/security.md)
--
-- * tx 해시 재사용 차단: 한 입금/송금 해시를 두 보상/두 payout에 기록할 수 없다 (서비스는 23505 → 409 TX_HASH_ALREADY_USED).
--   서비스가 저장 전 `0x`+소문자로 정규화하므로(common/validation/tx-hash.ts) 대소문자 변형도 같은 값으로 충돌한다.
--   기존 행은 인덱스 생성 전에 같은 규칙으로 정규화하고, 그래도 중복이 남으면 RAISE EXCEPTION으로 **마이그레이션을 실패시킨다**
--   (파일 하나가 트랜잭션 하나이므로 전부 롤백되고 _migrations에 0014 행이 남지 않는다 — 앱은 SchemaGuard가 MIGRATIONS_PENDING으로 기동을 거부).
--   에러 메시지에 중복 값(최대 10개, 건수 포함)과 조사용 SQL이 들어간다. 운영자가 중복을 정리한 뒤 `npm run migrate`를 다시 돌리면 적용된다.
-- * 탈퇴(soft delete)한 유저의 재로그인: uq_user_email / uq_user_google_id를 deleted_at IS NULL 행에만 걸어
--   같은 구글 계정으로 새 "user" 행을 만들 수 있게 한다 (upsertGoogleUser는 deleted_at IS NULL 행만 찾는다).
-- * refresh 회전 재사용 유예(30초) 컬럼.
-- * 에이전트 재등록: uq_agent_wallet / uq_agent_public_key가 REVOKED 행을 무시한다 — 폐기한 에이전트를 soft delete하지 않고도
--   같은 지갑/키로 다시 등록할 수 있고, 폐기된 에이전트의 제출/지원 이력은 그대로 남는다 (agents.service.ts register()).
-- 모든 문장은 재실행 가능(IF NOT EXISTS / IF EXISTS / 조건부 DO 블록).
-- ============================================================

-- ── tx 해시 정규화 (서비스 규칙과 동일: 32바이트 hex → `0x` + 소문자) ───────
-- hex 모양이 아닌 레거시 값은 손대지 않는다 (아래 중복 검사에는 포함된다).
UPDATE bounty_reward
   SET deposit_tx_hash = '0x' || lower(regexp_replace(deposit_tx_hash, '^0[xX]', ''))
 WHERE deposit_tx_hash ~ '^(0[xX])?[0-9a-fA-F]{64}$'
   AND deposit_tx_hash <> '0x' || lower(regexp_replace(deposit_tx_hash, '^0[xX]', ''));

UPDATE payout
   SET payout_tx_hash = '0x' || lower(regexp_replace(payout_tx_hash, '^0[xX]', ''))
 WHERE payout_tx_hash ~ '^(0[xX])?[0-9a-fA-F]{64}$'
   AND payout_tx_hash <> '0x' || lower(regexp_replace(payout_tx_hash, '^0[xX]', ''));

-- ── tx 해시 유니크 (NULL 제외) — 중복이 남아 있으면 마이그레이션 실패 (운영자가 정리 후 재실행) ──────
DO $$
DECLARE
  dup_count INT;
  sample    TEXT;
BEGIN
  SELECT count(*), string_agg(format('%s (x%s)', hash, cnt), ', ' ORDER BY hash) FILTER (WHERE rn <= 10)
    INTO dup_count, sample
    FROM (SELECT deposit_tx_hash AS hash, count(*) AS cnt, row_number() OVER (ORDER BY deposit_tx_hash) AS rn
            FROM bounty_reward WHERE deposit_tx_hash IS NOT NULL
           GROUP BY deposit_tx_hash HAVING count(*) > 1) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = format(
        '0014: cannot create uq_bounty_reward_deposit_tx — %s duplicate bounty_reward.deposit_tx_hash value(s); resolve them, then run `npm run migrate` again. First %s: %s. Inspect with: SELECT deposit_tx_hash, count(*), array_agg(id) FROM bounty_reward WHERE deposit_tx_hash IS NOT NULL GROUP BY deposit_tx_hash HAVING count(*) > 1;',
        dup_count, least(dup_count, 10), sample);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bounty_reward_deposit_tx ON bounty_reward(deposit_tx_hash) WHERE deposit_tx_hash IS NOT NULL;

DO $$
DECLARE
  dup_count INT;
  sample    TEXT;
BEGIN
  SELECT count(*), string_agg(format('%s (x%s)', hash, cnt), ', ' ORDER BY hash) FILTER (WHERE rn <= 10)
    INTO dup_count, sample
    FROM (SELECT payout_tx_hash AS hash, count(*) AS cnt, row_number() OVER (ORDER BY payout_tx_hash) AS rn
            FROM payout WHERE payout_tx_hash IS NOT NULL
           GROUP BY payout_tx_hash HAVING count(*) > 1) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = format(
        '0014: cannot create uq_payout_tx — %s duplicate payout.payout_tx_hash value(s); resolve them, then run `npm run migrate` again. First %s: %s. Inspect with: SELECT payout_tx_hash, count(*), array_agg(id) FROM payout WHERE payout_tx_hash IS NOT NULL GROUP BY payout_tx_hash HAVING count(*) > 1;',
        dup_count, least(dup_count, 10), sample);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_tx ON payout(payout_tx_hash) WHERE payout_tx_hash IS NOT NULL;

-- ── 유저 이메일/구글 ID 유니크를 활성 행으로 한정 ───────────
-- 0001: CREATE UNIQUE INDEX uq_user_google_id ON "user"(google_id);
--       CREATE UNIQUE INDEX uq_user_email     ON "user"(email);
DROP INDEX IF EXISTS uq_user_google_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_google_id ON "user"(google_id) WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uq_user_email;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email ON "user"(email) WHERE deleted_at IS NULL;

-- ── refresh 회전 재사용 유예(30초) + 재사용 감지 사슬 ──────
-- 후속 세션 행이 선행 토큰 해시와 회전 시각을 적는다. grace_refresh_token은 후속 refresh token 원문을
-- AES-256-GCM(JWT_SECRET 파생 키)으로 감싼 30초 수명 사본 — auth/refresh-grace.ts. 창이 지나면 MaintenanceService가 비운다.
ALTER TABLE auth_session
  ADD COLUMN IF NOT EXISTS prev_refresh_token_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS prev_rotated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_refresh_token     TEXT;

CREATE INDEX IF NOT EXISTS idx_auth_session_prev_token
  ON auth_session(prev_refresh_token_hash) WHERE prev_refresh_token_hash IS NOT NULL;

-- ── 에이전트 지갑/공개키 유니크에서 REVOKED 행 제외 ─────────
-- 0008: CREATE UNIQUE INDEX uq_agent_public_key ON agent(public_key)     WHERE deleted_at IS NULL;
--       CREATE UNIQUE INDEX uq_agent_wallet     ON agent(wallet_address) WHERE deleted_at IS NULL;
-- 폐기(REVOKED)된 에이전트는 더 이상 지갑/키를 점유하지 않는다 — 재등록 시 soft delete 없이 새 행을 만들 수 있고 이력은 남는다.
DROP INDEX IF EXISTS uq_agent_public_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_public_key
  ON agent(public_key) WHERE deleted_at IS NULL AND status <> 'REVOKED';

DROP INDEX IF EXISTS uq_agent_wallet;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_wallet
  ON agent(wallet_address) WHERE deleted_at IS NULL AND status <> 'REVOKED';
