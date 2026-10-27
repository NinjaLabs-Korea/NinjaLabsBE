#!/usr/bin/env node
/**
 * 지급할 수 없는 수상 몰수 — 승인(APPROVED)됐지만 payout을 만들 수 없는 제출(예: 수상자가 지갑을 연결하지 않고 연락 두절)을
 * REJECTED로 되돌려 바운티를 COMPLETED/CANCELLED로 닫을 수 있게 한다 (docs/runbook.md §7.4 "지급할 수 없는 수상").
 *
 *   node scripts/forfeit-award.js <submission-id> --reason <text> --admin <admin-user-id> [--dry-run] [--yes]
 *
 *   --reason   몰수 사유 (필수, 앞뒤 공백 제거 후 1~500자). 심사 기록 코멘트 'forfeited: <reason>'과 감사 행에 남는다.
 *              이 코멘트는 제출자의 `GET /submissions/me` review_comment로 보인다.
 *   --admin    결정한 운영자의 user id — 활성(ACTIVE, 탈퇴 안 함) is_admin 유저여야 한다. 심사 기록 reviewer와 감사 actor가 된다.
 *   --dry-run  검사 결과와 계획만 출력하고 아무것도 쓰지 않는다
 *   --yes      확인 프롬프트를 건너뛴다 (비대화형 실행은 필수)
 *
 * 한 트랜잭션에서 (submission-review.service.ts와 같은 잠금 순서: bounty → bounty_submission):
 *   - 바운티가 삭제되지 않았고 진행 상태(OPEN/SUBMISSION_CLOSED/IN_REVIEW), 제출이 APPROVED,
 *     그 제출의 payout 행이 **하나도** 없고(상태 무관 — 있으면 §7.4의 payout 정정/취소로 다룬다) 완료 NFT 행도 없어야 한다.
 *     운영자 id는 활성 is_admin 유저여야 한다. 하나라도 어긋나면 아무것도 쓰지 않고 이유를 출력한다 (exit 1).
 *   - bounty_submission: APPROVED → REJECTED (reviewed_at = now()).
 *   - submission_review: reviewer = 운영자, decision 'REJECT'(0005 CHECK 값), comment 'forfeited: <reason>', 현재 리비전.
 *   - audit_log: SUBMISSION_AWARD_FORFEITED (actor = 운영자, entity_type 'bounty_submission',
 *     before_data {status}, after_data {status, reason, bountyId, source}).
 * 결과: max_winners 자리가 하나 빈다, 공개 프로필 completedBounties·명예의전당 집계(APPROVED 기준)에서 이 수상이 빠진다 — 사례별 운영자 결정.
 * 스키마 변경 없음. 접속: DATABASE_URL (+ DATABASE_CA_CERT / PGSSLMODE) — scripts/migrate.js와 같은 규칙 (scripts/ops-cli.js).
 */
const { OpsError, UUID_RE, extractValueOptions, parseArgs, promptYes, runCli } = require('./ops-cli');

const USAGE = 'usage: node scripts/forfeit-award.js <submission-id> --reason <text (1-500 chars)> --admin <admin-user-id> [--dry-run] [--yes]';
/** src/bounties/bounty-status.ts IN_PROGRESS의 사본 — 심사(SubmissionReviewService)가 받는 바운티 상태와 같다 (forfeit-award.spec.ts가 대조) */
const FORFEITABLE_BOUNTY_STATUSES = ['OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW'];
const ACTION = 'SUBMISSION_AWARD_FORFEITED';
const SOURCE = 'scripts/forfeit-award.js';
const REASON_MAX = 500;
const RUNBOOK = 'docs/runbook.md §7.4';

/** 사유 정규화 — 앞뒤 공백 제거, 1~500자가 아니면 null */
function normalizeReason(raw) {
  if (typeof raw !== 'string') return null;
  const reason = raw.trim();
  return reason.length >= 1 && reason.length <= REASON_MAX ? reason : null;
}

/** 심사 기록 코멘트 */
function reviewComment(reason) {
  return `forfeited: ${reason}`;
}

/**
 * 제출·바운티·운영자 상태 조회. lock이면 바운티 → 제출 순서로 FOR UPDATE (한 트랜잭션 안에서만 의미 있음).
 * @returns {Promise<{ submission: object|null, admin: object|null }>}
 */
async function inspectSubmission(runner, submissionId, adminId, lock = false) {
  const head = await runner.query(`SELECT bounty_id FROM bounty_submission WHERE id = $1`, [submissionId]);
  let submission = null;
  if (head.rowCount) {
    if (lock) await runner.query(`SELECT id FROM bounty WHERE id = $1 FOR UPDATE`, [head.rows[0].bounty_id]);
    const r = await runner.query(
      `SELECT s.id, s.bounty_id, s.status AS submission_status, s.current_revision_no,
              b.status AS bounty_status, b.deleted_at IS NOT NULL AS bounty_deleted,
              (SELECT count(*)::int FROM payout p WHERE p.submission_id = s.id) AS payouts,
              (SELECT count(*)::int FROM nft n WHERE n.submission_id = s.id) AS nfts
         FROM bounty_submission s JOIN bounty b ON b.id = s.bounty_id
        WHERE s.id = $1 ${lock ? 'FOR UPDATE OF s' : ''}`,
      [submissionId],
    );
    submission = r.rows[0] || null;
  }
  const a = await runner.query(
    `SELECT id, is_admin, status, deleted_at IS NOT NULL AS deleted FROM "user" WHERE id = $1`,
    [adminId],
  );
  return { submission, admin: a.rows[0] || null };
}

/** 거부 사유 (없으면 null) — 순수 함수 */
function refusalReason(submission, admin) {
  if (!admin || !admin.is_admin || admin.deleted || admin.status !== 'ACTIVE') return 'admin id is not an active admin user';
  if (!submission) return 'submission not found';
  if (submission.bounty_deleted) return 'bounty is deleted';
  if (!FORFEITABLE_BOUNTY_STATUSES.includes(submission.bounty_status)) {
    return `bounty is ${submission.bounty_status}, expected one of ${FORFEITABLE_BOUNTY_STATUSES.join('/')}`;
  }
  if (submission.submission_status !== 'APPROVED') return `submission is ${submission.submission_status}, not APPROVED`;
  if (submission.payouts > 0) {
    return `${submission.payouts} payout row(s) exist for this submission - correct or cancel the payout per ${RUNBOOK} instead`;
  }
  if (submission.nfts > 0) return `a completion NFT exists for this submission - not an unpayable award (${RUNBOOK})`;
  return null;
}

/**
 * 몰수 (한 트랜잭션). 잠근 뒤 다시 검사하므로 그 사이 바뀐 상태는 거부된다.
 * @returns {Promise<{ bountyId: string }>} 거부되면 OpsError throw (롤백)
 */
async function forfeitAward(pool, submissionId, adminId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { submission, admin } = await inspectSubmission(client, submissionId, adminId, true);
    const refused = refusalReason(submission, admin);
    if (refused) throw new OpsError('REFUSED', refused);
    await client.query(`UPDATE bounty_submission SET status = 'REJECTED', reviewed_at = now() WHERE id = $1`, [submissionId]);
    const rev = await client.query(
      `SELECT id FROM submission_revision WHERE submission_id = $1 AND revision_no = $2`,
      [submissionId, submission.current_revision_no],
    );
    await client.query(
      `INSERT INTO submission_review (submission_id, revision_id, reviewer_id, decision, comment)
       VALUES ($1, $2, $3, 'REJECT', $4)`,
      [submissionId, rev.rows[0] ? rev.rows[0].id : null, adminId, reviewComment(reason)],
    );
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, $2, 'bounty_submission', $3, jsonb_build_object('status', $4::text),
               jsonb_build_object('status', 'REJECTED', 'reason', $5::text, 'bountyId', $6::text, 'source', $7::text))`,
      [adminId, ACTION, submissionId, submission.submission_status, reason, submission.bounty_id, SOURCE],
    );
    await client.query('COMMIT');
    return { bountyId: submission.bounty_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * CLI 본체 — 테스트가 pool/prompt/log를 주입해 그대로 돌린다. 종료 코드를 돌려준다.
 * @param {string[]} argv
 * @param {{ pool: import('pg').Pool, prompt?: (q: string) => Promise<boolean>, log?: (line: string) => void }} deps
 */
async function run(argv, deps) {
  const log = deps.log || console.log;
  const prompt = deps.prompt || promptYes;
  let parsed;
  let values;
  try {
    const extracted = extractValueOptions(argv, ['reason', 'admin']);
    values = extracted.values;
    parsed = parseArgs(extracted.rest, ['dry-run', 'yes']);
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  const { flags, positional } = parsed;
  const reason = normalizeReason(values.reason);
  if (positional.length !== 1 || !UUID_RE.test(positional[0]) || !reason || !values.admin || !UUID_RE.test(values.admin)) {
    // 사용법만 찍으면 운영자가 어느 인자가 틀렸는지 알 수 없다 - 틀린 인자를 먼저 이름으로 알려 준다
    const problems = [];
    if (positional.length !== 1) problems.push(`expected exactly one <submission-id>, got ${positional.length}`);
    else if (!UUID_RE.test(positional[0])) problems.push('<submission-id> must be a UUID');
    if (values.reason === undefined) problems.push('--reason <text> is required');
    else if (!reason) problems.push(`--reason must be 1 to ${REASON_MAX} characters after trimming (got ${values.reason.trim().length})`);
    if (values.admin === undefined) problems.push('--admin <admin-user-id> is required');
    else if (!UUID_RE.test(values.admin)) problems.push('--admin must be a user UUID');
    log(`${problems.join('\n')}\n${USAGE}`);
    return 2;
  }
  const submissionId = positional[0].toLowerCase();
  const adminId = values.admin.toLowerCase();

  const { submission, admin } = await inspectSubmission(deps.pool, submissionId, adminId);
  const refused = refusalReason(submission, admin);
  if (refused) {
    log(`refused  ${submissionId} - ${refused}`);
    return 1;
  }
  log(`award    ${submissionId}  bounty=${submission.bounty_id} (${submission.bounty_status})  status=${submission.submission_status}  payouts=0`);
  log(`plan     submission APPROVED -> REJECTED, review REJECT by ${adminId} "${reviewComment(reason)}" (+ audit ${ACTION})`);
  log('effect   frees one maxWinners slot; the win leaves the public profile completedBounties and Hall of Fame counts');
  if (flags['dry-run']) {
    log('dry-run  nothing written');
    return 0;
  }
  if (!flags.yes && !(await prompt(`Forfeit the approved award ${submissionId} (bounty ${submission.bounty_id})?`))) {
    log('aborted  nothing written (non-interactive runs need --yes)');
    return 1;
  }
  try {
    await forfeitAward(deps.pool, submissionId, adminId, reason);
    log(`done     submission ${submissionId} REJECTED (award forfeited)`);
    return 0;
  } catch (err) {
    if (err instanceof OpsError) {
      log(`refused  ${submissionId} - ${err.message}`);
      return 1;
    }
    throw err;
  }
}

module.exports = {
  run, forfeitAward, inspectSubmission, refusalReason, normalizeReason, reviewComment,
  FORFEITABLE_BOUNTY_STATUSES, ACTION, REASON_MAX,
};

if (require.main === module) runCli(run);
