import { ConfigService } from '@nestjs/config';
import { InjectiveNftClient } from './injective-nft.client';

// @injectivelabs/sdk-ts는 ESM이라 jest(commonjs)에서 못 불러온다 - 생성자 인자만 기록하는 껍데기로 대체한다
const wasmCtor = jest.fn();
const broadcasterCtor = jest.fn();
/** cw721 `owner_of` smart query - tests script its answer (resolved = token exists, rejected = contract/network error) */
const fetchSmartContractState = jest.fn(async (..._args: unknown[]) => ({}));
jest.mock('@injectivelabs/sdk-ts', () => ({
  ChainGrpcWasmApi: class { constructor(endpoint: string) { wasmCtor(endpoint); } fetchSmartContractState = (...args: unknown[]) => fetchSmartContractState(...args); },
  MsgBroadcasterWithPk: class { constructor(options: unknown) { broadcasterCtor(options); } broadcast = jest.fn(async () => ({ txHash: 'tx' })); },
  MsgExecuteContract: { fromJSON: jest.fn((msg: unknown) => msg) },
  PrivateKey: { fromMnemonic: jest.fn(() => ({ toBech32: () => 'inj1master' })) },
}));
jest.mock('@injectivelabs/networks', () => ({
  Network: { Mainnet: 'mainnet', Testnet: 'testnet' },
  getNetworkEndpoints: jest.fn((network: string) => ({
    grpc: `https://grpc.${network}.preset`, indexer: `https://indexer.${network}.preset`, rest: `https://rest.${network}.preset`,
  })),
}));

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] } as unknown as ConfigService);

beforeEach(() => {
  wasmCtor.mockClear();
  broadcasterCtor.mockClear();
  fetchSmartContractState.mockReset().mockResolvedValue({});
});

describe('InjectiveNftClient endpoints', () => {
  it.each([['mainnet', 'mainnet'], [' Mainnet ', 'mainnet'], ['MAINNET', 'mainnet'], ['testnet', 'testnet'], [' TestNet', 'testnet'], ['', 'testnet'], [undefined, 'testnet']])(
    'reads INJECTIVE_NETWORK=%j as %s (case and surrounding whitespace do not matter)',
    async (value, network) => {
      const client = new InjectiveNftClient(config({ INJECTIVE_NETWORK: value, NFT_CONTRACT_ADDRESS: 'inj1c', MASTER_WALLET_MNEMONIC: 'm' }));
      await client.mint('t', 'inj1owner');
      expect(broadcasterCtor).toHaveBeenLastCalledWith(expect.objectContaining({ network }));
    },
  );

  it('refuses an unknown INJECTIVE_NETWORK instead of silently using testnet', async () => {
    const client = new InjectiveNftClient(config({ INJECTIVE_NETWORK: 'main-net', NFT_CONTRACT_ADDRESS: 'inj1c', MASTER_WALLET_MNEMONIC: 'm' }));
    await expect(client.tokenExists('t')).rejects.toThrow('INJECTIVE_NETWORK must be "mainnet" or "testnet" (got "main-net")');
    await expect(client.mint('t', 'inj1owner')).rejects.toThrow('INJECTIVE_NETWORK must be');
    expect(wasmCtor).not.toHaveBeenCalled();
    expect(broadcasterCtor).not.toHaveBeenCalled();
  });

  it('uses the INJECTIVE_NETWORK preset gRPC endpoint when INJECTIVE_GRPC_ENDPOINT is unset or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      const client = new InjectiveNftClient(config({ INJECTIVE_NETWORK: 'testnet', INJECTIVE_GRPC_ENDPOINT: value, NFT_CONTRACT_ADDRESS: 'inj1c' }));
      await client.tokenExists('t');
      expect(wasmCtor).toHaveBeenLastCalledWith('https://grpc.testnet.preset');
    }
  });

  it('overrides only grpc (smart queries and the broadcaster alike) when INJECTIVE_GRPC_ENDPOINT is set', async () => {
    const client = new InjectiveNftClient(config({
      INJECTIVE_NETWORK: 'mainnet', INJECTIVE_GRPC_ENDPOINT: ' https://grpc.dedicated.example:443 ', NFT_CONTRACT_ADDRESS: 'inj1c', MASTER_WALLET_MNEMONIC: 'm',
    }));
    await client.tokenExists('t');
    expect(wasmCtor).toHaveBeenCalledWith('https://grpc.dedicated.example:443');
    await client.mint('t', 'inj1owner');
    expect(broadcasterCtor).toHaveBeenCalledWith(expect.objectContaining({
      network: 'mainnet',
      endpoints: { grpc: 'https://grpc.dedicated.example:443', indexer: 'https://indexer.mainnet.preset', rest: 'https://rest.mainnet.preset' },
    }));
  });

  it('builds the wasm client once (cached across queries)', async () => {
    const client = new InjectiveNftClient(config({ INJECTIVE_NETWORK: 'testnet', NFT_CONTRACT_ADDRESS: 'inj1c' }));
    await client.tokenExists('a');
    await client.tokenExists('b');
    expect(wasmCtor).toHaveBeenCalledTimes(1);
  });
});

describe('InjectiveNftClient tokenExists', () => {
  const client = () => new InjectiveNftClient(config({ INJECTIVE_NETWORK: 'testnet', NFT_CONTRACT_ADDRESS: 'inj1contract' }));

  it('asks the contract owner_of for the token id and reports true when it answers', async () => {
    await expect(client().tokenExists('token-1')).resolves.toBe(true);
    expect(fetchSmartContractState).toHaveBeenCalledWith('inj1contract', { owner_of: { token_id: 'token-1' } });
  });

  it.each([
    ['a cw721 "not found" contract error in message', new Error('query wasm contract failed: cw721_base::state::TokenInfo not found')],
    ['sdk-ts originalMessage carrying "not found"', Object.assign(new Error('Request failed'), { originalMessage: 'token_id not found: query wasm contract failed' })],
    ['any casing of not found', new Error('NOT FOUND')],
    ['a non-Error rejection whose text says not found', 'owner_of: not found'],
  ])('returns false (token not minted yet) for %s', async (_label, rejection) => {
    fetchSmartContractState.mockRejectedValueOnce(rejection);
    await expect(client().tokenExists('token-1')).resolves.toBe(false);
  });

  it.each([
    ['a network error', new Error('ECONNREFUSED 10.0.0.1:443')],
    ['a gRPC unavailable error', Object.assign(new Error('14 UNAVAILABLE: no connection established'), { originalMessage: 'Connection dropped' })],
    ['a contract error that is not "not found"', new Error('query wasm contract failed: unauthorized')],
  ])('rethrows %s unchanged so the worker retries instead of re-minting over an unknown chain state', async (_label, failure) => {
    fetchSmartContractState.mockRejectedValueOnce(failure);
    await expect(client().tokenExists('token-1')).rejects.toBe(failure);
  });
});

describe('InjectiveNftClient configuration and mint', () => {
  it.each([
    [{ MASTER_WALLET_MNEMONIC: 'm', NFT_CONTRACT_ADDRESS: 'inj1c' }, true],
    [{ MASTER_WALLET_MNEMONIC: 'm' }, false],
    [{ NFT_CONTRACT_ADDRESS: 'inj1c' }, false],
    [{ MASTER_WALLET_MNEMONIC: '', NFT_CONTRACT_ADDRESS: 'inj1c' }, false],
    [{ MASTER_WALLET_MNEMONIC: 'm', NFT_CONTRACT_ADDRESS: ' \n' }, false],
    [{ MASTER_WALLET_MNEMONIC: '  ', NFT_CONTRACT_ADDRESS: 'inj1c' }, false],
  ])('isConfigured(%j) is %s - the worker defers jobs unless both the mnemonic and the contract are set', (values, expected) => {
    expect(new InjectiveNftClient(config(values)).isConfigured()).toBe(expected);
  });

  it('contractAddress() drops surrounding whitespace from a pasted value', () => {
    expect(new InjectiveNftClient(config({ NFT_CONTRACT_ADDRESS: ' inj1c\n' })).contractAddress()).toBe('inj1c');
  });

  it('contractAddress() is empty (never a placeholder) when NFT_CONTRACT_ADDRESS is unset', () => {
    expect(new InjectiveNftClient(config({})).contractAddress()).toBe('');
  });

  it('mint executes cw721 `mint` from the master wallet with token_uri null when none is given and returns the tx hash', async () => {
    const { MsgExecuteContract } = jest.requireMock('@injectivelabs/sdk-ts') as { MsgExecuteContract: { fromJSON: jest.Mock } };
    const client = new InjectiveNftClient(config({ INJECTIVE_NETWORK: 'testnet', NFT_CONTRACT_ADDRESS: 'inj1contract', MASTER_WALLET_MNEMONIC: 'm' }));

    await expect(client.mint('token-9', 'inj1owner')).resolves.toBe('tx');
    expect(MsgExecuteContract.fromJSON).toHaveBeenLastCalledWith({
      sender: 'inj1master',
      contractAddress: 'inj1contract',
      msg: { mint: { token_id: 'token-9', owner: 'inj1owner', token_uri: null, extension: null } },
    });
    await client.mint('token-10', 'inj1owner', 'ipfs://meta');
    expect(MsgExecuteContract.fromJSON.mock.calls.at(-1)![0].msg.mint.token_uri).toBe('ipfs://meta');
    // the broadcaster (and the private key derivation) is built once per client
    expect(broadcasterCtor).toHaveBeenCalledTimes(1);
    expect(broadcasterCtor).toHaveBeenCalledWith(expect.objectContaining({ network: 'testnet', simulateTx: true }));
  });
});
