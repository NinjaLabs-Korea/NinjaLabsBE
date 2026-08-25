import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MsgBroadcasterWithPk,
  MsgExecuteContract,
  PrivateKey,
} from '@injectivelabs/sdk-ts';
import { Network } from '@injectivelabs/networks';

/**
 * cw721-base 민팅 클라이언트 (경로 A — 표준 CW-721)
 *
 * - 부모/자식 관계는 DB(nft.parent_nft_id)가 소스 오브 트루스.
 *   온체인에는 표준 cw721 mint만 수행한다. (Nestable 컨트랙트 전환 시 이 클래스만 교체)
 * - 마스터 지갑은 민팅 전용 — decisions.md: 탈취되어도 자금 피해 없음.
 */
@Injectable()
export class InjectiveNftClient {
  private readonly logger = new Logger(InjectiveNftClient.name);
  private broadcaster?: MsgBroadcasterWithPk;
  private masterAddress?: string;

  constructor(private readonly config: ConfigService) {}

  /** env 미설정이면 false — 워커가 잡을 미루는 판단에 사용 */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('MASTER_WALLET_MNEMONIC') &&
        this.config.get<string>('NFT_CONTRACT_ADDRESS'),
    );
  }

  contractAddress(): string {
    return this.config.get<string>('NFT_CONTRACT_ADDRESS') ?? '';
  }

  private network(): Network {
    return this.config.get<string>('INJECTIVE_NETWORK') === 'mainnet'
      ? Network.Mainnet
      : Network.Testnet;
  }

  private getBroadcaster(): { broadcaster: MsgBroadcasterWithPk; sender: string } {
    if (!this.broadcaster) {
      const pk = PrivateKey.fromMnemonic(
        this.config.get<string>('MASTER_WALLET_MNEMONIC') ?? '',
      );
      this.masterAddress = pk.toBech32();
      this.broadcaster = new MsgBroadcasterWithPk({
        privateKey: pk,
        network: this.network(),
        simulateTx: true,
      });
    }
    return { broadcaster: this.broadcaster, sender: this.masterAddress! };
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
