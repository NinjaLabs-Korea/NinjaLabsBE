-- ============================================================
-- 0015_performance_indexes.sql - 조회 경로 인덱스 (성능 점검 후속)
--
-- 모든 문장은 CREATE INDEX IF NOT EXISTS 로 재실행 가능하다. scripts/migrate.js 는 파일 하나를 트랜잭션 하나로 적용하므로
-- CREATE INDEX CONCURRENTLY 는 쓸 수 없다 - 지금 테이블은 작아 일반 CREATE INDEX 의 잠금 시간이 문제되지 않는다.
--
-- * "본인 또는 내 에이전트" 조회 (applications.service myApplications/withdraw, submissions.service mySubmissions,
--   users.service publicProfile): 술어를 `col = $1 OR agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 …))`
--   로 바꿔 두 컬럼 인덱스의 BitmapOr 로 풀리게 했다. 기존 인덱스는 bounty_id 선행(idx_submission_bounty, idx_application_bounty,
--   uq_submission_agent(bounty_id, agent_id), uq_application_agent(bounty_id, agent_id))뿐이라 agent_id/submitter 선행 조회를 돕지 못한다.
--   bounty_submission(agent_id, status) 는 /agents/me 의 completed_bounties 카운트(`agent_id = a.id AND status = 'APPROVED'`)도 받는다.
-- * nft_job(started_at) WHERE status = 'PROCESSING': NftJobWorker.requeueStaleJobs 의 고아 정리 (idx_nft_job_pending 은 PENDING 전용).
-- * auth_session: MaintenanceService.sweep - grace 사본 비우기(prev_rotated_at, grace_refresh_token IS NOT NULL 행만),
--   30일 지난 폐기/만료 세션 DELETE(revoked_at / expires_at). refresh 의 만료 검사(`expires_at > now()`)는 refresh_token_hash 인덱스로 이미 한 행이다.
-- * payout(payout_tx_hash) WHERE NOT NULL: RewardsService.markPaid 의 "다른 바운티에 이미 PAID 로 기록된 해시" 조회
--   (유니크가 아니다 - 멀티시그 한 tx 가 같은 바운티의 여러 payout 에 정당하게 기록된다, 0014 머리말).
-- ============================================================

-- ── bounty_submission / bounty_application: 제출자·에이전트 선행 조회 ─────────
CREATE INDEX IF NOT EXISTS idx_submission_submitter    ON bounty_submission(submitter_user_id);
CREATE INDEX IF NOT EXISTS idx_submission_agent_status ON bounty_submission(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_application_applicant   ON bounty_application(applicant_user_id);
CREATE INDEX IF NOT EXISTS idx_application_agent       ON bounty_application(agent_id);

-- ── nft_job: 고아 PROCESSING 잡 정리 ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_nft_job_processing ON nft_job(started_at) WHERE status = 'PROCESSING';

-- ── auth_session: 유지보수 스윕 ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_auth_session_grace   ON auth_session(prev_rotated_at) WHERE grace_refresh_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_session_expires ON auth_session(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_session_revoked ON auth_session(revoked_at) WHERE revoked_at IS NOT NULL;

-- ── payout: markPaid 해시 재사용 조회 ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_payout_tx_hash ON payout(payout_tx_hash) WHERE payout_tx_hash IS NOT NULL;
