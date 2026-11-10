-- 0029_payout_address.sql
-- 2026-11-10 결정(구글 로그인 전용): 지갑 연결을 없애고, 승인된 제출의 제출자가 지급 주소를 직접 입력한다.
-- payout은 요청 시점의 주소를 recipient_address로 스냅샷한다. 서명 없이 형식만 본다(앱: common/validation/injective-address.ts).
-- 비파괴: wallet/agent/nft 테이블과 컬럼은 남긴다. 옛 바이너리(지갑 기반 requestPayout)는 이 파일 적용 뒤에도 동작한다.
-- 저장 표기는 소문자 inj1 bech32(20바이트 계정) 하나. 0x 표기는 같은 바이트라 앱이 계산해 함께 내보낸다.
-- 추가·완화만 하고 재실행해도 안전하다(IF NOT EXISTS, DROP CONSTRAINT IF EXISTS, CREATE OR REPLACE).

ALTER TABLE bounty_submission
  ADD COLUMN IF NOT EXISTS payout_address VARCHAR(64),
  ADD COLUMN IF NOT EXISTS payout_address_updated_at TIMESTAMPTZ;
ALTER TABLE bounty_submission DROP CONSTRAINT IF EXISTS chk_submission_payout_address;
ALTER TABLE bounty_submission ADD CONSTRAINT chk_submission_payout_address
  CHECK (payout_address IS NULL OR payout_address ~ '^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$');
ALTER TABLE bounty_submission DROP CONSTRAINT IF EXISTS chk_submission_payout_address_stamp;
ALTER TABLE bounty_submission ADD CONSTRAINT chk_submission_payout_address_stamp
  CHECK ((payout_address IS NULL) = (payout_address_updated_at IS NULL));

ALTER TABLE payout ADD COLUMN IF NOT EXISTS recipient_address VARCHAR(64);
ALTER TABLE payout ALTER COLUMN recipient_wallet_id DROP NOT NULL;
ALTER TABLE payout DROP CONSTRAINT IF EXISTS chk_payout_recipient_address;
ALTER TABLE payout ADD CONSTRAINT chk_payout_recipient_address
  CHECK (recipient_address IS NULL OR recipient_address ~ '^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$');
ALTER TABLE payout DROP CONSTRAINT IF EXISTS chk_payout_recipient;
ALTER TABLE payout ADD CONSTRAINT chk_payout_recipient
  CHECK (recipient_wallet_id IS NOT NULL OR recipient_address IS NOT NULL);

COMMENT ON COLUMN bounty_submission.payout_address IS '수상자가 입력한 지급 주소(소문자 inj1). APPROVED 제출의 제출자만, payout 행이 생기기 전까지만 바꾼다';
COMMENT ON COLUMN bounty_submission.payout_address_updated_at IS '지급 주소를 마지막으로 설정한 시각. payout_address와 함께 NULL이다';
COMMENT ON COLUMN payout.recipient_address IS '요청 시점 지급 주소 스냅샷(소문자 inj1). 0029 이후 payout의 수령자';
COMMENT ON COLUMN payout.recipient_wallet_id IS '레거시: 0029 이전 지갑 기반 payout의 수령 지갑. 새 payout은 NULL';

-- 0026 트리거는 지갑 교체 뒤의 옛 writer를 막는다. 주소 기반 payout(recipient_wallet_id NULL)은 지갑과 무관하므로 그냥 통과시킨다.
-- 본문은 0026 원본 그대로이고 맨 앞의 IF 한 줄만 더했다.
CREATE OR REPLACE FUNCTION protect_replaced_wallet_payout() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_id UUID; revision BIGINT; target_id UUID;
BEGIN
  -- 0029: address-based payouts (recipient_wallet_id NULL) are not tied to a wallet, so let them through.
  -- Everything below is the 0026 body unchanged.
  IF NEW.recipient_wallet_id IS NULL THEN RETURN NEW; END IF;
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
