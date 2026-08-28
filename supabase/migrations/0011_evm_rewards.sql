-- Injective EVM / MultiVM reward metadata.
-- Native USDC is an ERC-20 on EVM and is addressable as erc20:<lowercase address>
-- from Cosmos bank/exchange surfaces.

ALTER TABLE bounty_reward
  ADD COLUMN evm_chain_id BIGINT;

ALTER TABLE bounty_reward
  DROP CONSTRAINT IF EXISTS bounty_reward_token_type_check,
  DROP CONSTRAINT IF EXISTS chk_reward_token;

ALTER TABLE bounty_reward
  ADD CONSTRAINT bounty_reward_token_type_check
    CHECK (token_type IN ('NATIVE', 'CW20', 'ERC20')),
  ADD CONSTRAINT chk_reward_token CHECK (
    (token_type = 'NATIVE' AND token_denom IS NOT NULL)
    OR (token_type = 'CW20' AND token_contract_address IS NOT NULL)
    OR (
      token_type = 'ERC20'
      AND token_contract_address ~ '^0x[0-9a-fA-F]{40}$'
      AND evm_chain_id IS NOT NULL
    )
  );

CREATE INDEX idx_bounty_reward_evm_token
  ON bounty_reward(evm_chain_id, lower(token_contract_address))
  WHERE token_type = 'ERC20';
