-- ============================================================
-- 0017_enable_rls.sql - public 스키마의 모든 테이블에 RLS 켜기 (정책 없음 = anon/authenticated 전부 거부)
--
-- Supabase는 public 스키마를 PostgREST(Data API)로 노출하고, 새 테이블에 anon/authenticated 역할의 기본 권한을 준다.
-- anon 키는 FE 번들에 실려도 되는 공개 키라서, RLS가 꺼진 테이블은 **키만 알면 누구나** `https://<project>.supabase.co/rest/v1/<table>`로
-- 읽고 쓸 수 있다 - `"user"`(이메일, `is_admin`), `auth_session`(refresh 토큰 해시·grace 사본), `agent_api_key`(키 해시),
-- `payout`/`bounty_reward`(지급 상태), `audit_log`까지. 0013/0016은 새 테이블에만 RLS를 켰고 나머지 24개는 꺼져 있었다.
--
-- 이 서비스는 PostgREST를 쓰지 않는다 - BE가 DATABASE_URL(Supabase `postgres` 역할 = 테이블 소유자, BYPASSRLS)로 직접 접속하므로
-- 정책 없는 RLS는 BE 동작을 바꾸지 않고 anon/authenticated 경로만 닫는다. (FORCE ROW LEVEL SECURITY는 쓰지 않는다 - 소유자까지 막는다.)
-- 일반 Postgres(로컬/CI)에는 anon 역할이 없지만 ENABLE은 똑같이 동작하고 재실행해도 안전하다.
--
-- 규칙: 앞으로 만드는 테이블도 자기 마이그레이션에서 `ALTER TABLE … ENABLE ROW LEVEL SECURITY`를 한다 -
-- src/test-support/rls-coverage.spec.ts가 CREATE TABLE마다 ENABLE을 요구한다.
-- ============================================================

ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounty ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounty_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounty_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounty_reward ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounty_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE nft ENABLE ROW LEVEL SECURITY;
ALTER TABLE nft_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_highlight ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_verification_challenge ENABLE ROW LEVEL SECURITY;
