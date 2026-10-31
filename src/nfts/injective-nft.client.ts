import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChainGrpcWasmApi,
  MsgBroadcasterWithPk,
  MsgExecuteContract,
  PrivateKey,
} from '@injectivelabs/sdk-ts';
import { getNetworkEndpoints, Network, NetworkEndpoints } from '@injectivelabs/networks';

/**
 * cw721-base 민팅 클라이언트 (경로 A - 표준 CW-721)
 *
 * - 부모/자식 관계는 DB(nft.parent_nft_id)가 소스 오브 트루스.
 *   온체인에는 표준 cw721 mint만 수행한다. (Nestable 컨트랙트 전환 시 이 클래스만 교체)
 * - 마스터 지갑은 민팅 전용 - decisions.md: 탈취되어도 자금 피해 없음.
 */
@Injectable()
export class InjectiveNftClient {
  private readonly logger = new Logger(InjectiveNftClient.name);
  private broadcaster?: MsgBroadcasterWithPk;
  private masterAddress?: string;
  private wasm?: ChainGrpcWasmApi;

  constructor(private readonly config: ConfigService) {}

  /** 앞뒤 공백(대시보드 붙여넣기의 줄바꿈 등)을 뗀 env 값 - 공백뿐이면 미설정 */
  private env(key: string): string | undefined {
    return this.config.get<string>(key)?.trim() || undefined;
  }

  /** env 미설정(공백뿐인 값 포함)이면 false - 워커가 잡을 미루는 판단에 사용 */
  isConfigured(): boolean {
    return Boolean(this.env('MASTER_WALLET_MNEMONIC') && this.env('NFT_CONTRACT_ADDRESS'));
  }

  contractAddress(): string {
    return this.env('NFT_CONTRACT_ADDRESS') ?? '';
  }

  /**
   * 미설정·빈 값은 testnet(기본값). `mainnet`/`testnet`은 앞뒤 공백·대소문자를 무시한다 - 'Mainnet'이나 ' mainnet'을 조용히 testnet으로 읽어
   * mainnet 컨트랙트 주소로 testnet 노드를 부르던 것을 막는다. 그 밖의 값은 throw: 잡이 실패하고 `last_error`/운영 알림에 값이 보인다.
   */
  private network(): Network {
    const raw = this.config.get<string>('INJECTIVE_NETWORK')?.trim().toLowerCase();
    if (!raw || raw === 'testnet') return Network.Testnet;
    if (raw === 'mainnet') return Network.Mainnet;
    throw new Error(`INJECTIVE_NETWORK must be "mainnet" or "testnet" (got ${JSON.stringify(raw.slice(0, 40))})`);
  }

  /** 네트워크 프리셋 엔드포인트. `INJECTIVE_GRPC_ENDPOINT`가 있으면 gRPC만 그 값으로 덮어쓴다 (전용 노드/프록시) - 브로드캐스터와 스마트 쿼리가 같은 노드를 본다 */
  private endpoints(): NetworkEndpoints {
    const preset = getNetworkEndpoints(this.network());
    const grpc = this.config.get<string>('INJECTIVE_GRPC_ENDPOINT')?.trim();
    return grpc ? { ...preset, grpc } : preset;
  }

  private getBroadcaster(): { broadcaster: MsgBroadcasterWithPk; sender: string } {
    if (!this.broadcaster) {
      const pk = PrivateKey.fromMnemonic(
        this.env('MASTER_WALLET_MNEMONIC') ?? '',
      );
      this.masterAddress = pk.toBech32();
      this.broadcaster = new MsgBroadcasterWithPk({
        privateKey: pk,
        network: this.network(),
        endpoints: this.endpoints(),
        simulateTx: true,
      });
    }
    return { broadcaster: this.broadcaster, sender: this.masterAddress! };
  }

  /** 브로드캐스터와 같은 gRPC 엔드포인트로 CosmWasm 스마트 쿼리 */
  private getWasm(): ChainGrpcWasmApi {
    if (!this.wasm) this.wasm = new ChainGrpcWasmApi(this.endpoints().grpc);
    return this.wasm;
  }

  /**
   * 토큰이 이미 온체인에 존재하는가 - cw721 `owner_of` 스마트 쿼리.
   * mint 브로드캐스트와 DB 갱신 사이에 워커가 죽으면 재실행 시 같은 token_id로 다시 민팅해 컨트랙트가 거부하므로,
   * 민팅 전에 이 값으로 복구 여부를 판단한다. 컨트랙트의 "not found" 응답만 false, 네트워크 오류는 그대로 던진다.
   */
  async tokenExists(tokenId: string): Promise<boolean> {
    try {
      await this.getWasm().fetchSmartContractState(this.contractAddress(), { owner_of: { token_id: tokenId } });
      return true;
    } catch (err) {
      if (InjectiveNftClient.isNotFound(err)) return false;
      throw err;
    }
  }

  /** cw721-base는 없는 토큰에 `... not found` 류의 컨트랙트 오류를 돌려준다 (sdk-ts 예외는 message/originalMessage에 담는다) */
  private static isNotFound(err: unknown): boolean {
    const texts = [
      err instanceof Error ? err.message : String(err),
      (err as { originalMessage?: unknown })?.originalMessage,
    ];
    return texts.some((text) => typeof text === 'string' && /not found/i.test(text));
  }

  /**
   * cw721-base mint 실행
   * @param tokenId  고유 토큰 id (nft.id UUID 사용)
   * @param owner    수령자 inj1... 주소
   * @param tokenUri 메타데이터 URI (없으면 null)
   * @returns 트랜잭션 해시
   */
  async mint(tokenId: string, owner: string, tokenUri?: string | null): Promise<string> {
    const { broadcaster, sender } = this.getBroadcaster();
    const msg = MsgExecuteContract.fromJSON({
      sender,
      contractAddress: this.contractAddress(),
      msg: {
        mint: {
          token_id: tokenId,
          owner,
          token_uri: tokenUri ?? null,
          extension: null,
        },
      },
    });
    const res = await broadcaster.broadcast({ msgs: msg });
    this.logger.log(`minted token ${tokenId} → ${owner} (tx ${res.txHash})`);
    return res.txHash;
  }
}
