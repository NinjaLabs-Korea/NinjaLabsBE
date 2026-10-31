import { sqlColumnPrefix } from '../common/database/sql-alias';

/**
 * "연결된 대표 지갑" SQL 조건의 단일 출처: is_primary이고 연결 해제되지 않은 지갑(유저당 최대 1개, 부분 유니크 인덱스).
 * /auth/me 지갑, 내 지갑, payout 수령 지갑(requestPayout), 운영 화면 수령 지갑 주소, 어드민 유저 검색이 같은 조건을 쓴다.
 *
 * 의존성 없는 모듈이다(wallets.service는 ESM 전용 SDK를 끌어오므로 다른 모듈은 이 파일만 import한다).
 *
 * @param w 지갑 테이블 별칭. 빈 문자열이면 접두사 없이
 */
export function primaryWalletSql(w = 'w'): string {
  const c = sqlColumnPrefix(w, 'primaryWalletSql');
  return `${c}is_primary = true AND ${c}disconnected_at IS NULL`;
}
