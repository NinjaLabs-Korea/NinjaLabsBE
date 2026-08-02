import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

/**
 * NFT 도메인 (ERD §11)
 *
 * - Ninja 부모 NFT: 지갑 연결(verify) 성공 시 enqueueParentMint 호출
 * - 완료 자식 NFT: 제출물 APPROVED + payout 이후 enqueueChildMint 호출
 * - 실제 온체인 실행은 nft_job 큐 + NftJobWorker가 담당 (API 흐름과 분리)
 * - CW-721 Nestable 컨트랙트는 2팀 산출물 — 주소는 NFT_CONTRACT_ADDRESS env
 */
@Injectable()
export class NftsService {
  constructor(private readonly db: DatabaseService) {}

  /** 부모 NFT 레코드 생성 + 민팅 잡 등록 (지갑 연결 성공 시 호출) */
  async enqueueParentMint(userId: string, walletId: string) {
    const contract = process.env.NFT_CONTRACT_ADDRESS ?? 'PENDING_CONTRACT_DEPLOY';
    return this.db.tx(async (tx) => {
      const nft = await tx.query<{ id: string }>(
        `INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address)
         VALUES ($1, $2, 'NINJA_PARENT', $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, walletId, contract],
      );
      if (!nft.rowCount) return null; // 이미 부모 NFT 존재 (1유저 1부모)
      const nftId = nft.rows[0].id;
      await tx.query(
        `INSERT INTO nft_job (nft_id, job_type, idempotency_key)
         VALUES ($1, 'MINT_PARENT', $2)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [nftId, `mint-parent:${userId}`],
      );
      return { nftId };
    });
  }

  /** 자식 NFT 레코드 생성 + 민팅/attach 잡 등록 (제출물 승인 시 호출) */
  async enqueueChildMint(userId: string, walletId: string, bountyId: string, submissionId: string) {
    const contract = process.env.NFT_CONTRACT_ADDRESS ?? 'PENDING_CONTRACT_DEPLOY';
    return this.db.tx(async (tx) => {
      const parent = await tx.query<{ id: string }>(
        `SELECT id FROM nft WHERE owner_user_id = $1 AND nft_type = 'NINJA_PARENT'`,
        [userId],
      );
      // 부모 NFT 미보유(지갑 미연결 등)면 부모부터 재유도 — decisions.md 참고
      const parentId = parent.rowCount ? parent.rows[0].id : null;

      const nft = await tx.query<{ id: string }>(
        `INSERT INTO nft (owner_user_id, owner_wallet_id, parent_nft_id, bounty_id, submission_id, nft_type, contract_address)
         VALUES ($1, $2, $3, $4, $5, 'BOUNTY_COMPLETION_CHILD', $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, walletId, parentId, bountyId, submissionId, contract],
      );
      if (!nft.rowCount) return null;
      const nftId = nft.rows[0].id;
      await tx.query(
        `INSERT INTO nft_job (nft_id, job_type, idempotency_key)
         VALUES ($1, 'MINT_CHILD', $2)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [nftId, `mint-child:${submissionId}`],
      );
      return { nftId, parentId };
    });
  }

  /** 유저의 NFT 목록 (프로필 페이지용) */
  async listByUser(userId: string) {
    const r = await this.db.query(
      `SELECT id, nft_type, status, token_id, metadata_uri, mint_tx_hash, minted_at, attached_at
         FROM nft WHERE owner_user_id = $1
        ORDER BY created_at`,
      [userId],
    );
    return r.rows;
  }
}
