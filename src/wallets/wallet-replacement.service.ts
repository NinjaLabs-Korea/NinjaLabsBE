import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ownedAgentIdsSql } from '../agents/owned-agents';
import { AuditService } from '../audit/audit.service';
import { signatureSchemeFor } from '../common/crypto/wallet-signature';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { WALLET_CHANGE_READY_NFT_STATUSES, TERMINAL_NFT_JOB_STATUSES } from '../nfts/nft-status';
import { UNSETTLED_PAYOUT_STATUSES } from '../rewards/payout-status';
import { activeUserSql } from '../users/active-user';
import { primaryWalletSql } from './primary-wallet';
import { injectiveWalletAddress, normalizeWalletAddress, sameWalletAccount } from './wallet-address';

type Tx = Pick<DatabaseService, 'query'>;
type WalletRow = { id: string; chain: string; address: string; verified_at: Date; created_at: Date };
type ChallengeRow = {
  id: string; current_wallet_id: string; current_signing_address: string; new_signing_address: string;
  new_address: string; current_message: string; new_message: string; valid: boolean;
  completed_at: Date | null; new_wallet_id: string | null;
};
export type ReplacementProof = {
  challengeId: string; currentSignature: string; newSignature: string;
  currentPublicKey?: string; newPublicKey?: string;
};

/** Replace only the primary receiving wallet. Historical wallet rows, payouts and NFTs are immutable here. */
@Injectable()
export class WalletReplacementService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly config: ConfigService) {}

  private assertEnabled() {
    // Fail closed, including unset/typo values. This is an operator gate, not fleet-version detection.
    if (this.config.get<string>('WALLET_REPLACEMENT_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('WALLET_CHANGE_DISABLED');
    }
  }

  private async lockOwner(tx: Tx, userId: string) {
    const owner = await tx.query(`SELECT id FROM "user" WHERE id = $1 AND ${activeUserSql('')} FOR UPDATE`, [userId]);
    if (!owner.rowCount) throw new NotFoundException('USER_NOT_FOUND');
  }

  private async primary(tx: Tx, userId: string): Promise<WalletRow> {
    const wallet = await tx.query<WalletRow>(
      `SELECT id, chain, address, verified_at, created_at FROM wallet WHERE user_id = $1 AND ${primaryWalletSql('')}`, [userId]);
    if (!wallet.rowCount) throw new ConflictException('WALLET_CHANGE_REQUIRES_WALLET');
    return wallet.rows[0];
  }

  private async assertSafe(tx: Tx, userId: string, newAddress: string) {
    const payouts = await tx.query(
      `SELECT 1 FROM payout p JOIN bounty_submission s ON s.id = p.submission_id
        WHERE p.status = ANY($2::text[]) AND
          (s.submitter_user_id = $1 OR s.agent_id = ANY(${ownedAgentIdsSql('$1', 'including-deleted')})
           OR p.recipient_wallet_id = ANY(ARRAY(SELECT id FROM wallet WHERE user_id = $1))) LIMIT 1`,
      [userId, [...UNSETTLED_PAYOUT_STATUSES]]);
    if (payouts.rowCount) throw new ConflictException('WALLET_CHANGE_BLOCKED_PAYOUTS');
    const jobs = await tx.query(
      `SELECT 1 FROM nft n WHERE n.owner_user_id = $1 AND
        (n.status <> ALL($2::text[]) OR EXISTS
          (SELECT 1 FROM nft_job j WHERE j.nft_id = n.id AND j.status <> ALL($3::text[]))) LIMIT 1`,
      [userId, [...WALLET_CHANGE_READY_NFT_STATUSES], [...TERMINAL_NFT_JOB_STATUSES]]);
    if (jobs.rowCount) throw new ConflictException('WALLET_CHANGE_BLOCKED_NFT_JOBS');
    const agents = await tx.query<{ wallet_address: string }>(
      `SELECT wallet_address FROM agent WHERE owner_user_id = $1 AND status <> 'REVOKED' AND deleted_at IS NULL`, [userId]);
    if (agents.rows.some((row) => sameWalletAccount(row.wallet_address, newAddress))) {
      throw new BadRequestException('AGENT_WALLET_IS_OWNER_WALLET');
    }
    const occupied = await tx.query(`SELECT id FROM wallet WHERE chain = 'INJECTIVE' AND address = $1 AND disconnected_at IS NULL`, [newAddress]);
    if (occupied.rowCount) throw new ConflictException('WALLET_LINKED_TO_OTHER_ACCOUNT');
  }

  async createChallenge(userId: string, currentAddress: string, newAddress: string) {
    this.assertEnabled();
    const current = normalizeWalletAddress(currentAddress);
    const target = normalizeWalletAddress(newAddress);
    const targetAccount = injectiveWalletAddress(target);
    return this.db.tx(async (tx) => {
      await this.lockOwner(tx, userId);
      const wallet = await this.primary(tx, userId);
      if (!sameWalletAccount(current, wallet.address)) throw new ConflictException('WALLET_CHANGE_STALE');
      if (sameWalletAccount(target, wallet.address)) throw new BadRequestException('WALLET_CHANGE_SAME_ADDRESS');
      await this.assertSafe(tx, userId, targetAccount);
      const id = randomUUID();
      const expiry = (await tx.query<{ expires_at: Date }>(`SELECT clock_timestamp() + interval '5 minutes' AS expires_at`)).rows[0].expires_at;
      const common = [
        'NinjaLabs receiving wallet replacement / 수령 지갑 교체',
        `User: ${userId}`, `Current wallet ID: ${wallet.id}`,
        `From: ${wallet.address}`, `To: ${targetAccount}`, `Request: ${id}`, `Expires: ${expiry.toISOString()}`,
        'Existing NFTs and payout records will NOT move. No blockchain transaction is sent.',
        'Future completion NFTs stay on the existing parent NFT wallet. Only future payouts use the new receiving wallet.',
        '기존 NFT와 지급 이력은 이전되지 않습니다. 온체인 송금이 없는 계정 설정 변경입니다.',
        '이후 보상금만 새 수령 지갑으로 받으며, 이후 완료 NFT도 기존 부모 NFT 지갑에 발급됩니다.',
      ];
      const currentMessage = [...common, 'Authorization: CURRENT wallet releases primary receiving role.'].join('\n');
      const newMessage = [...common, 'Authorization: NEW wallet accepts primary receiving role.'].join('\n');
      await tx.query(`DELETE FROM wallet_replacement_challenge WHERE user_id = $1 AND completed_at IS NULL`, [userId]);
      await tx.query(
        `INSERT INTO wallet_replacement_challenge
          (id, user_id, current_wallet_id, current_signing_address, new_signing_address, new_address, current_message, new_message, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, wallet.id, current, target, targetAccount, currentMessage, newMessage, expiry]);
      return { id, currentAddress: current, newAddress: target, currentMessage, newMessage, expiresAt: expiry };
    });
  }

  async verify(userId: string, proof: ReplacementProof): Promise<WalletRow> {
    this.assertEnabled();
    try {
      return await this.db.tx(async (tx) => {
        await this.lockOwner(tx, userId);
        const result = await tx.query<ChallengeRow>(
          `SELECT *, expires_at > clock_timestamp() AS valid FROM wallet_replacement_challenge WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [proof.challengeId, userId]);
        if (!result.rowCount) throw new NotFoundException('WALLET_CHANGE_NOT_FOUND');
        const request = result.rows[0];
        if (!request.completed_at && !request.valid) throw new BadRequestException('CHALLENGE_EXPIRED');
        const oldKey = signatureSchemeFor(request.current_signing_address).verify({
          address: request.current_signing_address, message: request.current_message,
          signature: proof.currentSignature, publicKey: proof.currentPublicKey,
        });
        const newKey = signatureSchemeFor(request.new_signing_address).verify({
          address: request.new_signing_address, message: request.new_message,
          signature: proof.newSignature, publicKey: proof.newPublicKey,
        });
        if (!oldKey || !newKey) throw new UnauthorizedException('INVALID_SIGNATURE');
        const wallet = await this.primary(tx, userId);
        if (request.completed_at) {
          if (wallet.id !== request.new_wallet_id) throw new ConflictException('WALLET_CHANGE_STALE');
          return wallet; // Same request, same proofs: a lost response cannot perform a second replacement.
        }
        if (wallet.id !== request.current_wallet_id) throw new ConflictException('WALLET_CHANGE_STALE');
        await this.assertSafe(tx, userId, request.new_address);
        await tx.query(`UPDATE wallet SET is_primary = false, disconnected_at = now() WHERE id = $1`, [wallet.id]);
        const inserted = await tx.query<WalletRow>(
          `INSERT INTO wallet (user_id, chain, address, public_key, is_primary, verified_at)
            VALUES ($1, 'INJECTIVE', $2, $3, true, now()) RETURNING id, chain, address, verified_at, created_at`,
          [userId, request.new_address, newKey.publicKey]);
        const replacement = inserted.rows[0];
        // Permanent compatibility marker; challenge cleanup must not erase the rollback boundary.
        await tx.query(`UPDATE "user" SET receiving_wallet_revision = receiving_wallet_revision + 1 WHERE id = $1`, [userId]);
        const completed = await tx.query(
          `UPDATE wallet_replacement_challenge SET completed_at = clock_timestamp(), new_wallet_id = $2
            WHERE id = $1 AND completed_at IS NULL AND expires_at > clock_timestamp() RETURNING id`, [request.id, replacement.id]);
        if (!completed.rowCount) throw new BadRequestException('CHALLENGE_EXPIRED');
        // Do not lock/delete first-link challenges while holding the owner lock: legacy verify
        // locks a challenge before inserting its wallet. Its unique-primary constraint already
        // prevents a first-link proof from replacing a wallet; purging here could deadlock it.
        await this.audit.record(userId, 'WALLET_REPLACED', 'user', userId, tx, {
          before: { walletId: wallet.id }, after: { walletId: replacement.id },
        });
        return replacement;
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err, 'uq_wallet_chain_address_active')) throw new ConflictException('WALLET_LINKED_TO_OTHER_ACCOUNT');
      throw err;
    }
  }
}
