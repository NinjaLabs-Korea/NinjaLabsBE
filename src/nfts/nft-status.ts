/**
 * NFT 상태 규칙의 **단일 출처** (nft.status CHECK: supabase/migrations/0007_nfts.sql, nft-status.spec.ts가 대조한다).
 *
 * 전이: PENDING -> MINTING -> MINTED -> ATTACHING -> ATTACHED, 어느 단계에서든 5회 실패하면 FAILED.
 * 상태 집합을 문자열 리터럴로 새로 만들지 말고 여기 상수를 쓴다 (정적 가드: test-support/status-literals.spec.ts).
 *
 * 같이 움직이는 곳:
 *   - nfts/nft-job.worker.ts          부모 준비 판정, ATTACH_CHILD UPDATE 조건
 *   - nfts/nft-jobs-admin.service.ts  운영자 재시도 (REQUEUE_JOB_SQL, RESTORE_NFT_AFTER_REQUEUE_SQL)
 *   - highlights/highlights.service.ts  공개 통계의 완료 NFT 수
 * src 밖 사본 (scripts는 src를 import하지 않는다. nft-status.spec.ts가 어긋나면 실패시킨다):
 *   - scripts/requeue-nft-jobs.js     재큐 SQL 두 문장
 */

import { sqlStatusList } from '../rewards/payout-status';

/** nft 테이블 CHECK와 같은 전체 상태 */
export const NFT_STATUSES = ['PENDING', 'MINTING', 'MINTED', 'ATTACHING', 'ATTACHED', 'FAILED'] as const;
export type NftStatus = (typeof NFT_STATUSES)[number];

/** 자식을 attach할 수 있는 부모 상태 */
export const PARENT_READY: readonly NftStatus[] = ['MINTED', 'ATTACHED'];
/** 민팅 잡이 다시 민팅하지 않고 건너뛰는, 이미 민팅된 NFT 자신의 상태 (멱등성. 부모 조건인 PARENT_READY와 따로 둔다) */
export const MINT_ALREADY_DONE: readonly NftStatus[] = ['MINTED', 'ATTACHED'];
/** attach 대상이 될 수 있는 자식 상태 (아직 ATTACHED가 아닌 민팅 완료분) */
export const ATTACHABLE: readonly NftStatus[] = ['MINTED', 'ATTACHING'];
/** 민팅이 끝난 상태 (공개 통계의 "완료 NFT") */
export const MINTED_OR_LATER: readonly NftStatus[] = ['MINTED', 'ATTACHING', 'ATTACHED'];

/** SQL `IN ('A', 'B')` 텍스트. 상수만 받는다 (바인딩 불가한 정적 집합용) */
export function sqlIn(statuses: readonly NftStatus[]): string {
  if (statuses.some((status) => !(NFT_STATUSES as readonly string[]).includes(status))) {
    throw new Error('sqlIn: expected NFT status constants');
  }
  return `IN (${sqlStatusList(statuses)})`;
}

/**
 * FAILED 잡 재큐 (운영자 재시도 + scripts/requeue-nft-jobs.js 공통). $1 = nft_job id 배열.
 * 서비스는 뒤에 RETURNING을 붙인다.
 */
export const REQUEUE_JOB_SQL = `UPDATE nft_job
            SET status = 'PENDING', retry_count = 0, scheduled_at = now(), started_at = NULL, processed_at = NULL
          WHERE id = ANY($1::uuid[]) AND status = 'FAILED'`;

/**
 * 재큐한 잡의 FAILED nft 복구. $1 = nft id 배열. token_id가 있으면 민팅은 끝났고 attach가 실패한 것이라 MINTED(재민팅 금지),
 * 없으면 PENDING. 워커의 tokenExists 복구도 token_id 기준이고 워커는 token_id와 minted_at을 같은 UPDATE에서 쓴다.
 */
export const RESTORE_NFT_AFTER_REQUEUE_SQL = `UPDATE nft SET status = CASE WHEN token_id IS NOT NULL THEN 'MINTED' ELSE 'PENDING' END
          WHERE status = 'FAILED' AND id = ANY($1::uuid[])`;
