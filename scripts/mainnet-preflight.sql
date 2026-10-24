-- ============================================================
-- scripts/mainnet-preflight.sql — testnet → mainnet 전환 전 읽기 전용 점검 (docs/runbook.md "testnet → mainnet 전환")
--
--   psql "$DATABASE_URL" -X -f scripts/mainnet-preflight.sql \
--     -v expected_custody=inj1...        # 새 mainnet 멀티시그 주소 (REWARD_MULTISIG_ADDRESS에 넣을 값)
--     -v expected_usdc=0x...             # mainnet USDC ERC-20 (USDC_EVM_CONTRACT_ADDRESS에 넣을 값)
--     -v expected_nft_contract=inj1...   # mainnet CW-721 (NFT_CONTRACT_ADDRESS에 넣을 값)
--   (-v는 모두 선택 — 비우면 그 값과의 비교만 건너뛴다)
--
-- 전체가 READ ONLY 트랜잭션 안에서 돌고 마지막에 ROLLBACK한다 — 아무것도 쓰지 않는다 (쓰기 문이 섞이면 Postgres가 거부).
-- 각 결과의 첫 열 `check`가 점검 이름이다. "blocker" 점검은 0행이어야 전환할 수 있다. "review"는 사람이 판단할 목록이다.
-- src/test-db/ops-scripts.db-spec.ts가 이 파일을 실 DB에 그대로 돌려 읽기 전용임과 placeholder 탐지를 검증한다
-- (테스트는 `\` 로 시작하는 psql 메타 줄을 빼고 `;`로 끝나는 줄 단위로 문장을 나눈다 — 문장 안에 `;`로 끝나는 줄을 두지 말 것).
-- ============================================================
\set ON_ERROR_STOP on
\if :{?expected_custody}
\else
\set expected_custody ''
\endif
\if :{?expected_usdc}
\else
\set expected_usdc ''
\endif
\if :{?expected_nft_contract}
\else
\set expected_nft_contract ''
\endif
\pset footer on

BEGIN TRANSACTION READ ONLY;

-- [blocker] 1. 열린 보상의 custody_address가 자리표시값/잘못된 모양/기대값과 다름.
--   PENDING_MULTISIG_SETUP은 REWARD_MULTISIG_ADDRESS 미설정 시 reward-token.resolver.ts가 넣는 값이다. 스폰서가 이 주소로 입금할 수 없다.
--   bech32 inj1 + 38자(계정) 또는 + 58자(컨트랙트 — cw3 멀티시그), 또는 EVM 0x + 40 hex(Safe 등 EVM 멀티시그 — runbook §9)만 정상으로 본다.
--   기대값 비교는 대소문자를 무시한다 (bech32는 소문자뿐이고, EVM 주소는 체크섬 대소문자가 섞여 들어올 수 있다).
SELECT 'custody_placeholder' AS check, r.id AS reward_id, r.bounty_id, b.title, r.status, r.custody_address
  FROM bounty_reward r JOIN bounty b ON b.id = r.bounty_id
 WHERE r.status IN ('DEPOSIT_PENDING', 'FUNDED', 'PARTIALLY_PAID', 'REFUND_PENDING')
   AND (r.custody_address = 'PENDING_MULTISIG_SETUP'
        OR (r.custody_address !~ '^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20})?$'
            AND r.custody_address !~ '^0x[0-9a-fA-F]{40}$')
        OR (:'expected_custody' <> '' AND lower(r.custody_address) <> lower(:'expected_custody')))
 ORDER BY r.created_at;

-- [blocker] 2. 열린 ERC-20 보상이 testnet 체인(1439) 또는 기대와 다른 USDC 컨트랙트를 가리킴 — mainnet EVM chain id는 1776.
SELECT 'erc20_testnet_chain' AS check, r.id AS reward_id, r.bounty_id, r.status, r.evm_chain_id, r.token_contract_address
  FROM bounty_reward r
 WHERE r.token_type = 'ERC20'
   AND r.status IN ('DEPOSIT_PENDING', 'FUNDED', 'PARTIALLY_PAID', 'REFUND_PENDING')
   AND (r.evm_chain_id IS DISTINCT FROM 1776
        OR (:'expected_usdc' <> '' AND lower(r.token_contract_address) <> lower(:'expected_usdc')))
 ORDER BY r.created_at;

-- [blocker] 3. 끝나지 않은 payout — testnet 멀티시그에서 승인/브로드캐스트 중인 지급은 전환 전에 PAID/FAILED/CANCELLED로 닫는다.
SELECT 'payout_open' AS check, p.id AS payout_id, p.bounty_reward_id, p.status, p.amount::text, p.requested_at
  FROM payout p
 WHERE p.status NOT IN ('PAID', 'FAILED', 'CANCELLED')
 ORDER BY p.requested_at;

-- [blocker] 4. 대기/진행/실패 nft_job — 전환 뒤 워커가 mainnet 컨트랙트로 민팅한다. 의도한 것만 남기고 나머지는 운영자가 CANCELLED로 정리한다.
SELECT 'nft_job_unfinished' AS check, j.status, j.job_type, count(*)::int AS jobs, min(j.created_at) AS oldest
  FROM nft_job j
 WHERE j.status IN ('PENDING', 'PROCESSING', 'FAILED')
 GROUP BY j.status, j.job_type
 ORDER BY j.status, j.job_type;

-- [review] 5. testnet에서 입금이 확인된(돈이 걸린) 보상 — testnet 토큰이므로 mainnet에서 다시 입금받거나 환불/취소 처리할지 결정한다.
SELECT 'reward_funded_on_testnet' AS check, r.id AS reward_id, r.bounty_id, r.status, r.display_symbol,
       r.amount::text, r.deposited_amount::text, r.deposit_tx_hash
  FROM bounty_reward r
 WHERE r.status IN ('FUNDED', 'PARTIALLY_PAID', 'REFUND_PENDING')
 ORDER BY r.deposited_at NULLS LAST;

-- [review] 6. 민팅된 NFT의 컨트랙트 분포 — testnet 컨트랙트에 남은 NFT는 mainnet에서 보이지 않는다. 재민팅 여부를 결정한다.
SELECT 'nft_contracts' AS check, n.contract_address, n.status, count(*)::int AS nfts,
       (:'expected_nft_contract' <> '' AND n.contract_address = :'expected_nft_contract') AS is_expected
  FROM nft n
 GROUP BY n.contract_address, n.status
 ORDER BY n.contract_address, n.status;

-- [review] 7. 활성 운영자 — 전환 당일 연락 가능한 사람인지 확인한다 (scripts/grant-admin.js로 정리).
SELECT 'active_admins' AS check, u.id, u.email, u.nickname, u.status
  FROM "user" u
 WHERE u.is_admin = true AND u.deleted_at IS NULL
 ORDER BY u.created_at;

-- [review] 8. 플랫폼 설정 — onboarding.nft_mint_enabled 등 체인에 닿는 스위치.
SELECT 'platform_settings' AS check, s.key, s.value::text, s.updated_at
  FROM platform_setting s
 ORDER BY s.key;

-- [review] 9. 마지막으로 적용된 마이그레이션 — 배포할 코드의 supabase/migrations 마지막 파일과 같아야 한다.
SELECT 'last_migration' AS check, m.name, m.applied_at
  FROM _migrations m
 ORDER BY m.name DESC
 LIMIT 1;

ROLLBACK;
