-- ============================================================
-- 0023_perf_indexes.sql: 로컬 부하 점검(운영 규모 시드: 유저 5천, NFT 잡 3.6천, 감사 로그 20만 - scripts/seed-perf.sql)에서 나온 정렬 인덱스 2개
--
--   idx_nft_job_status_updated  nft_job (status, updated_at DESC, id): 운영자 NFT 잡 목록 `WHERE status = $1 ORDER BY updated_at DESC, id LIMIT`
--                               가 seq scan + 전체 정렬이던 것을 인덱스 순서로 앞 30행만 읽게. (동시 50, 3회 중앙값: 865 -> 1836 rps, p95 92 -> 43 ms)
--   idx_user_created            "user" (created_at DESC, id) WHERE deleted_at IS NULL: 운영자 유저 검색 `ORDER BY created_at DESC, id LIMIT 30`
--                               (빈 검색어 = "최근 30명")이 전체 정렬 대신 앞 30행만 읽게. (동시 50: 962 -> 2908 rps, p95 76 -> 36 ms)
--
-- 비파괴 변경: 인덱스 추가 2개. 데이터·컬럼·RLS 변경 없음. 마이그레이션 실행기는 파일 전체를 한 트랜잭션으로 감싸 CONCURRENTLY를 쓸 수 없고,
-- 일반 CREATE INDEX는 만드는 동안 쓰기를 막는다: 두 테이블 모두 지금 작아(운영 유저 수백, 잡 수십) 잠금은 순간이다.
-- ============================================================

CREATE INDEX idx_nft_job_status_updated ON nft_job (status, updated_at DESC, id);

CREATE INDEX idx_user_created ON "user" (created_at DESC, id) WHERE deleted_at IS NULL;
