import { ConfigService } from '@nestjs/config';
import { InjectiveNftClient } from './injective-nft.client';

// @injectivelabs/sdk-ts는 ESM이라 jest(commonjs)에서 못 불러온다 — 생성자 인자만 기록하는 껍데기로 대체한다
const wasmCtor = jest.fn();
const broadcasterCtor = jest.fn();
jest.mock('@injectivelabs/sdk-ts', () => ({
  ChainGrpcWasmApi: class { constructor(endpoint: string) { wasmCtor(endpoint); } fetchSmartContractState = jest.fn(async () => ({})); },
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

describe('InjectiveNftClient endpoints', () => {
  const config = (values: Record<string, string | undefined>) =>
    ({ get: (key: string) => values[key] } as unknown as ConfigService);

  beforeEach(() => { wasmCtor.mockClear(); broadcasterCtor.mockClear(); });

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
