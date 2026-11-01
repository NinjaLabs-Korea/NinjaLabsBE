-- 로컬 성능/부하 점검용 시드 (운영 규모를 흉내 낸 가짜 데이터). 절대 운영 DB에 실행하지 않는다.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/seed-perf.sql      (마이그레이션을 다 적용한 **빈** DB)
-- 빈 DB가 아니면 중단한다("user" 행이 있으면 거부). 규모: 유저 5000, 멤버 50, 바운티 500, 지원 2만, 제출 1만, 보상 약 430, 지급 수천,
-- 공지 300, 하이라이트 100, 기수 3 + 지원서 3000, 감사 로그 20만, NFT 약 4천 + 잡. 결정적(random 대신 산술)이라 재현 가능하다.
-- 사용법과 기준 수치: docs/runbook.md "성능 기준선".
\set ON_ERROR_STOP on
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "user") THEN RAISE EXCEPTION 'seed-perf: "user" is not empty, refusing to seed'; END IF;
END $$;

-- 유저 5000: 1~3 어드민, 4~53 멤버, 나머지 일반. 전원 온보딩 완료.
INSERT INTO "user" (id, google_id, email, nickname, bio, onboarding_step, onboarding_completed_at, is_admin, is_member, member_role, member_display_order, created_at)
SELECT gen_random_uuid(), 'perf-g-' || i, 'perf-' || i || '@example.test', 'perf' || i, 'bio ' || i || ' ' || repeat('x', 60),
       4, now() - (i % 300 || ' days')::interval,
       i <= 3, i BETWEEN 4 AND 53,
       CASE WHEN i BETWEEN 4 AND 53 THEN (ARRAY['CORE','DEV','DESIGN','OPS'])[1 + i % 4] END,
       CASE WHEN i BETWEEN 4 AND 53 THEN i END,
       now() - ((5000 - i) / 14 || ' days')::interval
FROM generate_series(1, 5000) i;
CREATE TEMP TABLE pu AS SELECT substring(google_id from 8)::int AS n, id FROM "user";
CREATE UNIQUE INDEX ON pu (n);

INSERT INTO user_tag (user_id, tag) SELECT id, (ARRAY['DEV','DESIGN','CONTENT','OTHER'])[1 + n % 4] FROM pu;
INSERT INTO user_link (user_id, link_type, url, display_order) SELECT id, 'GITHUB', 'https://github.com/perf' || n, 0 FROM pu WHERE n % 2 = 0;

-- 지갑: 유저 1~4500
INSERT INTO wallet (id, user_id, address, is_primary, verified_at)
SELECT gen_random_uuid(), id, 'inj1' || substr(md5('w' || n), 1, 38), true, now() FROM pu WHERE n <= 4500;
CREATE TEMP TABLE pw AS SELECT pu.n, w.id AS wallet_id, w.user_id FROM wallet w JOIN pu ON pu.id = w.user_id;
CREATE UNIQUE INDEX ON pw (n);

-- 바운티 500: 상태 7종 균등(DRAFT 포함), 2%는 소프트 삭제
INSERT INTO bounty (id, created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, status,
                    application_required, max_winners, application_deadline, submission_deadline, opened_at, review_started_at, completed_at, created_at, deleted_at)
SELECT gen_random_uuid(), (SELECT id FROM pu WHERE n = 1), 'Sponsor ' || (i % 25), 'Perf bounty ' || i, 'summary ' || i || ' ' || repeat('s', 80),
       repeat('description ', 120), repeat('requirements ', 40), repeat('criteria ', 30),
       (ARRAY['DEV','DESIGN','CONTENT','OTHER'])[1 + i % 4],
       (ARRAY['DRAFT','FUNDING_PENDING','OPEN','SUBMISSION_CLOSED','IN_REVIEW','COMPLETED','CANCELLED'])[1 + i % 7],
       i % 2 = 0, 1 + i % 3,
       now() + ((i % 40) - 20 || ' days')::interval, now() + ((i % 60) - 30 || ' days')::interval,
       now() - ((i % 90) || ' days')::interval, now() - ((i % 60) || ' days')::interval, now() - ((i % 30) || ' days')::interval,
       now() - ((500 - i) / 2 || ' days')::interval,
       CASE WHEN i % 50 = 7 THEN now() END
FROM generate_series(1, 500) i;
CREATE TEMP TABLE pb AS
  SELECT row_number() OVER (ORDER BY created_at, title) AS rn, id, status FROM bounty WHERE status <> 'DRAFT' AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON pb (rn);
CREATE TEMP TABLE pbc AS SELECT count(*)::int AS c FROM pb;

-- 보상: 공개/진행 바운티마다 1개 (상태는 바운티 상태에서 유도)
INSERT INTO bounty_reward (id, bounty_id, token_type, token_denom, display_symbol, amount, custody_address, deposit_tx_hash, deposited_amount, status, deposited_at)
SELECT gen_random_uuid(), pb.id, 'NATIVE', 'inj', 'INJ', 1000000000000000000::numeric * (1 + pb.rn % 50), 'inj1' || substr(md5('multisig'), 1, 38),
       CASE WHEN pb.status NOT IN ('FUNDING_PENDING') THEN '0x' || md5('dep' || pb.rn) || md5('dep2' || pb.rn) END,
       CASE WHEN pb.status NOT IN ('FUNDING_PENDING') THEN 1000000000000000000::numeric * (1 + pb.rn % 50) ELSE 0 END,
       CASE pb.status WHEN 'FUNDING_PENDING' THEN 'DEPOSIT_PENDING' WHEN 'COMPLETED' THEN (ARRAY['PAID','PARTIALLY_PAID'])[1 + pb.rn % 2]
                      WHEN 'CANCELLED' THEN (ARRAY['REFUND_PENDING','REFUNDED'])[1 + pb.rn % 2] ELSE 'FUNDED' END,
       now() - (pb.rn % 40 || ' days')::interval
FROM pb;
CREATE TEMP TABLE pr AS SELECT r.id, r.bounty_id, r.amount, pb.rn FROM bounty_reward r JOIN pb ON pb.id = r.bounty_id;

-- 지원 2만 (바운티 x 유저 유일)
INSERT INTO bounty_application (id, bounty_id, applicant_user_id, message, portfolio_url, status, applied_at)
SELECT gen_random_uuid(), pb.id, pu.id, 'message ' || k || ' ' || repeat('m', 120), 'https://example.test/p/' || k,
       (ARRAY['PENDING','APPROVED','REJECTED','WITHDRAWN','APPROVED'])[1 + k % 5], now() - (k % 200 || ' days')::interval
FROM generate_series(0, 19999) k
JOIN pbc ON true
JOIN pb ON pb.rn = 1 + (k % pbc.c)
JOIN pu ON pu.n = 4 + ((k / pbc.c) * 97 + (k % pbc.c) * 7) % 4990;
CREATE TEMP TABLE pa AS
  SELECT a.id AS application_id, a.bounty_id, a.applicant_user_id AS user_id, row_number() OVER (ORDER BY a.applied_at, a.id) AS k
  FROM bounty_application a;

-- 제출 1만: 지원 행 앞쪽 1만 건에 대응 (같은 바운티 x 유저)
INSERT INTO bounty_submission (id, bounty_id, application_id, submitter_user_id, submission_url, description, repository_url, commit_sha, status, submitted_at, reviewed_at)
SELECT gen_random_uuid(), pa.bounty_id, pa.application_id, pa.user_id, 'https://example.test/s/' || pa.k, 'submission ' || pa.k || ' ' || repeat('d', 200),
       'https://github.com/perf/repo' || pa.k, md5(pa.k::text),
       (ARRAY['SUBMITTED','IN_REVIEW','REVISION_REQUESTED','RESUBMITTED','APPROVED','REJECTED','WITHDRAWN','APPROVED'])[1 + pa.k % 8],
       now() - (pa.k % 150 || ' days')::interval, now() - (pa.k % 100 || ' days')::interval
FROM pa WHERE pa.k <= 10000;
CREATE TEMP TABLE ps AS SELECT s.id, s.bounty_id, s.submitter_user_id AS user_id, s.status, row_number() OVER (ORDER BY s.submitted_at, s.id) AS k FROM bounty_submission s;

INSERT INTO submission_revision (submission_id, revision_no, submission_url, description, created_by_user_id)
SELECT id, 1, 'https://example.test/r/' || k, 'rev ' || k, user_id FROM ps;
INSERT INTO submission_review (submission_id, reviewer_id, decision, comment)
SELECT id, (SELECT id FROM pu WHERE n = 2), CASE status WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REJECTED' THEN 'REJECT' ELSE 'START_REVIEW' END, 'comment ' || k
FROM ps WHERE status IN ('APPROVED','REJECTED','IN_REVIEW','REVISION_REQUESTED');

-- 지급: 승인 제출 중 지갑 있는 유저, 보상 있는 바운티
INSERT INTO payout (id, bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, approved_by, payout_tx_hash, requested_at, paid_at)
SELECT gen_random_uuid(), pr.id, ps.id, pw.wallet_id, 100000000000000000::numeric, st.s, 'perf-payout-' || ps.k, (SELECT id FROM pu WHERE n = 2),
       CASE WHEN st.s IN ('APPROVED','BROADCASTING','PAID') THEN (SELECT id FROM pu WHERE n = 3) END,
       CASE WHEN st.s = 'PAID' THEN '0x' || md5('tx' || ps.k) || md5('tx2' || ps.k) END,
       now() - (ps.k % 60 || ' days')::interval, CASE WHEN st.s = 'PAID' THEN now() - (ps.k % 30 || ' days')::interval END
FROM ps JOIN pr ON pr.bounty_id = ps.bounty_id JOIN pw ON pw.user_id = ps.user_id
JOIN LATERAL (SELECT (ARRAY['REQUESTED','AWAITING_MULTISIG_APPROVAL','APPROVED','PAID','PAID','FAILED','CANCELLED'])[1 + (ps.k % 7)::int] AS s) st ON true
WHERE ps.status = 'APPROVED';

-- 공지 300 (+태그), 하이라이트 100
INSERT INTO notice (id, created_by, title, summary, body, category, status, published_at, event_date, created_at)
SELECT gen_random_uuid(), (SELECT id FROM pu WHERE n = 1), 'Perf notice ' || i, 'summary ' || i, repeat('body ', 400),
       (ARRAY['NINJALABS','INJECTIVE_ECOSYSTEM','EVENT','RECRUITMENT','OTHER'])[1 + i % 5],
       (ARRAY['PUBLISHED','PUBLISHED','PUBLISHED','DRAFT','ARCHIVED'])[1 + i % 5],
       now() - (i || ' days')::interval, CASE WHEN i % 5 = 2 THEN (now() - (i || ' days')::interval)::date END,
       now() - (i || ' days')::interval
FROM generate_series(1, 300) i;
INSERT INTO notice_tag (notice_id, tag) SELECT id, 'tag' || (row_number() OVER (ORDER BY title) % 6) FROM notice;
INSERT INTO platform_highlight (created_by, bounty_id, type, title, description, link_url, display_order, is_published, published_at)
SELECT (SELECT id FROM pu WHERE n = 1), CASE WHEN i % 4 = 0 THEN (SELECT id FROM pb WHERE rn = i) END,
       (ARRAY['MILESTONE','FEATURED_BOUNTY','PROJECT','PARTNERSHIP','AWARD','OTHER'])[1 + i % 6], 'Highlight ' || i, repeat('desc ', 30), 'https://example.test/h/' || i,
       i, i % 10 <> 0, now()
FROM generate_series(1, 100) i;

-- 기수 3 (OPEN 1, CLOSED 1, DRAFT 1) + 지원서 3000 (CLOSED 2000, OPEN 1000)
INSERT INTO cohort (id, name, status, opens_at, closes_at, created_by)
VALUES (gen_random_uuid(), 'Perf cohort 1', 'CLOSED', now() - interval '200 days', now() - interval '150 days', (SELECT id FROM pu WHERE n = 1)),
       (gen_random_uuid(), 'Perf cohort 2', 'OPEN', now() - interval '10 days', now() + interval '20 days', (SELECT id FROM pu WHERE n = 1)),
       (gen_random_uuid(), 'Perf cohort 3', 'DRAFT', NULL, NULL, (SELECT id FROM pu WHERE n = 1));
INSERT INTO cohort_application (cohort_id, user_id, display_name, telegram, twitter, intro, status, answers, created_at)
SELECT (SELECT id FROM cohort WHERE name = CASE WHEN i <= 2000 THEN 'Perf cohort 1' ELSE 'Perf cohort 2' END),
       (SELECT id FROM pu WHERE n = 100 + (CASE WHEN i <= 2000 THEN i ELSE i - 2000 END)),
       'Applicant ' || i, '@perf_tg' || i, '@perf_x' || i, 'intro ' || i || ' ' || repeat('i', 200),
       (ARRAY['SUBMITTED','ACCEPTED','REJECTED','WITHDRAWN'])[1 + i % 4],
       jsonb_build_array(jsonb_build_object('questionId','web3_experience','type','SINGLE_CHOICE','label',jsonb_build_object('ko','경험','en',null,'zh',null),'text',null,'choices',jsonb_build_array(jsonb_build_object('id','Y1_3','label',jsonb_build_object('ko','1-3년','en',null,'zh',null))),'other',null)),
       now() - (i % 180 || ' days')::interval
FROM generate_series(1, 3000) i;

-- NFT: 부모 NFT 2500 + 완료 자식(승인 제출 중 지갑 보유 약 1500) , 잡은 NFT마다 최대 1개
INSERT INTO nft (id, owner_user_id, owner_wallet_id, nft_type, contract_address, token_id, status, minted_at)
SELECT gen_random_uuid(), pw.user_id, pw.wallet_id, 'NINJA_PARENT', 'inj1contract', 'p' || pw.n,
       (ARRAY['PENDING','MINTING','MINTED','MINTED','FAILED','ATTACHED'])[1 + pw.n % 6], now()
FROM pw WHERE pw.n <= 2500;
INSERT INTO nft (id, owner_user_id, owner_wallet_id, parent_nft_id, bounty_id, submission_id, nft_type, contract_address, token_id, status)
SELECT gen_random_uuid(), pw.user_id, pw.wallet_id, par.id, ps.bounty_id, ps.id, 'BOUNTY_COMPLETION_CHILD', 'inj1contract', 'c' || ps.k,
       (ARRAY['PENDING','MINTED','ATTACHING','ATTACHED','FAILED'])[1 + ps.k % 5]
FROM ps JOIN pw ON pw.user_id = ps.user_id JOIN nft par ON par.owner_user_id = ps.user_id AND par.nft_type = 'NINJA_PARENT'
WHERE ps.status = 'APPROVED';
INSERT INTO nft_job (nft_id, job_type, idempotency_key, status, retry_count, last_error, scheduled_at, processed_at)
SELECT n.id, CASE n.nft_type WHEN 'NINJA_PARENT' THEN 'MINT_PARENT' ELSE 'ATTACH_CHILD' END, 'perf-job-' || n.id,
       (ARRAY['PENDING','PROCESSING','SUCCEEDED','SUCCEEDED','FAILED','CANCELLED'])[1 + (abs(hashtext(n.id::text)) % 6)],
       abs(hashtext(n.id::text)) % 4, CASE WHEN n.status = 'FAILED' THEN 'perf error' END, now() - (abs(hashtext(n.id::text)) % 40 || ' days')::interval, now()
FROM nft n;

-- 감사 로그 20만: 1년에 걸쳐 분포
INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data, created_at)
SELECT (SELECT id FROM pu WHERE n = 1 + i % 3), a.action, a.etype, gen_random_uuid(),
       jsonb_build_object('status', 'A', 'i', i), jsonb_build_object('status', 'B', 'note', 'audit entry ' || i),
       now() - (i * interval '157 seconds')
FROM generate_series(1, 200000) i
JOIN LATERAL (SELECT * FROM (VALUES
  ('BOUNTY_UPDATED','bounty'),('APPLICATION_APPROVED','bounty_application'),('SUBMISSION_APPROVE','bounty_submission'),
  ('PAYOUT_REQUESTED','payout'),('NOTICE_UPDATED','notice'),('COHORT_APPLICATION_ACCEPTED','cohort_application'),('BOUNTY_OPEN','bounty')
) v(action, etype) OFFSET (i % 7) LIMIT 1) a ON true;

COMMIT;
ANALYZE;
SELECT 'user' t, count(*) FROM "user" UNION ALL SELECT 'bounty', count(*) FROM bounty UNION ALL SELECT 'application', count(*) FROM bounty_application
UNION ALL SELECT 'submission', count(*) FROM bounty_submission UNION ALL SELECT 'payout', count(*) FROM payout UNION ALL SELECT 'audit_log', count(*) FROM audit_log
UNION ALL SELECT 'nft', count(*) FROM nft UNION ALL SELECT 'nft_job', count(*) FROM nft_job UNION ALL SELECT 'cohort_application', count(*) FROM cohort_application;
