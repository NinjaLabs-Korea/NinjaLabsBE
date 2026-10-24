import { QueryRunner } from '../common/database/database.service';

/**
 * 한 유저의 연결된 지갑을 전부 해제(disconnected_at) — 회원 탈퇴(users/account-withdrawal.service.ts)가 자기 트랜잭션 안에서 부른다.
 * 행은 지우지 않는다: payout.recipient_wallet_id / NFT FK가 남은 행을 가리키고, 같은 주소는 부분 유니크 인덱스(disconnected_at IS NULL)
 * 덕분에 새 계정으로 다시 연결할 수 있다.
 *
 * wallets.service.ts가 아니라 이 파일에 두는 이유: wallets.service는 @injectivelabs/sdk-ts(ESM 전용)를 끌어와 users 경로
 * (단위 테스트·test-db 포함)가 import하면 jest가 모듈을 못 불러온다. 여기는 DB만 의존한다.
 */
export async function disconnectAllWalletsOfUser(tx: QueryRunner, userId: string): Promise<void> {
  await tx.query(
    `UPDATE wallet SET disconnected_at = now()
      WHERE user_id = $1 AND disconnected_at IS NULL`,
    [userId],
  );
}
