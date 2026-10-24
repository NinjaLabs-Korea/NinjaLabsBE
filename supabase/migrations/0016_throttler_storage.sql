-- ============================================================
-- 0016_throttler_storage.sql — 레플리카 간 공유 rate limit 카운터 (THROTTLER_STORAGE=postgres)
--
-- @nestjs/throttler 기본 저장소는 프로세스 메모리라 레플리카 N대면 실효 한도가 N배가 된다. production은
-- common/throttler/pg-throttler-storage.ts 가 이 테이블에 **문장 하나짜리 원자적 upsert**로 카운트한다 (INSERT … ON CONFLICT DO UPDATE —
-- 같은 key 의 동시 요청은 행 잠금으로 직렬화되므로 레플리카가 몇 대든 한 버킷을 정확히 나눠 쓴다).
--
--   key            throttler 이름 + guard 가 만든 키(sha256 또는 `agent-api:agent:<id>`) — 원문 토큰/IP 는 guard 가 이미 해시한다(auth-token, default)
--   hits           현재 고정 창(window) 안의 요청 수
--   expires_at     창이 끝나는 시각 — 지나면 다음 요청이 hits=1 로 새 창을 연다
--   blocked_until  한도를 넘긴 순간 now()+blockDuration. 그때까지는 카운트하지 않고 429. 지나면 새 창으로 다시 시작
--
-- UNLOGGED: 카운터는 휘발성 데이터다 — 요청마다 쓰는 핫 경로라 WAL 을 남기지 않는다. 크래시 복구 시 비워지는데, 그 결과는
-- "한도가 한 번 초기화됨"뿐이다. 읽기 복제본에는 실리지 않는다(읽을 일 없음).
-- 정리: MaintenanceService.sweep (매시) 가 창과 차단이 모두 지난 행을 지운다 — idx_throttler_storage_expires.
-- RLS: 서버 전용 테이블 (Supabase anon/authenticated 역할에 노출하지 않음, 0013 과 동일).
-- ============================================================

CREATE UNLOGGED TABLE IF NOT EXISTS throttler_storage (
  key            TEXT PRIMARY KEY,
  hits           INTEGER NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  blocked_until  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_throttler_storage_expires ON throttler_storage(expires_at);
ALTER TABLE throttler_storage ENABLE ROW LEVEL SECURITY;
