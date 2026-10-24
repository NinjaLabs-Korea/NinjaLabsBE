/**
 * npm audit 게이트 — `npm audit --omit=dev --json` 결과에서 high/critical advisory가
 * audit-allowlist.json에 없으면 실패한다.
 *
 * allowlist 항목: { id: "GHSA-…", reason: "…", expires: "YYYY-MM-DD" }
 *   - 만료일이 지난 항목이 하나라도 있으면 (해당 advisory가 아직 남아 있든 아니든) 실패 — 보류 결정을 주기적으로 다시 보게 만든다.
 *   - id/reason/expires가 빠진 항목도 실패.
 * 사용: node scripts/audit-gate.js   (CI의 audit job)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BLOCKING = new Set(['high', 'critical']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** npm audit v2 JSON에서 high/critical advisory를 모은다 (via 객체가 advisory, 문자열은 다른 패키지로의 전이). */
function collectAdvisories(report) {
  const found = new Map();
  const vulns = (report && report.vulnerabilities) || {};
  for (const [pkg, v] of Object.entries(vulns)) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!BLOCKING.has(via.severity)) continue;
      const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url || '');
      const id = m ? m[0] : String(via.source ?? `${pkg}:${via.title}`);
      if (!found.has(id)) found.set(id, { id, pkg: via.name || pkg, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...found.values()];
}

/** @returns {{ ok: boolean, errors: string[], allowed: object[], blocked: object[] }} */
function evaluate(report, allowlist, today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const entries = new Map();
  for (const [i, e] of (allowlist || []).entries()) {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.reason !== 'string' || !e.reason.trim() || !DATE_RE.test(e.expires || '')) {
      errors.push(`allowlist[${i}] is malformed (needs id, reason, expires YYYY-MM-DD)`);
      continue;
    }
    if (e.expires < today) errors.push(`allowlist entry ${e.id} expired on ${e.expires} - re-evaluate or renew it`);
    entries.set(e.id.toLowerCase(), e);
  }
  const allowed = [];
  const blocked = [];
  for (const adv of collectAdvisories(report)) {
    (entries.has(adv.id.toLowerCase()) ? allowed : blocked).push(adv);
  }
  for (const adv of blocked) errors.push(`${adv.severity} advisory not allowlisted: ${adv.id} ${adv.pkg} - ${adv.title} ${adv.url || ''}`.trim());
  return { ok: errors.length === 0, errors, allowed, blocked };
}

// 네트워크 장애는 advisory가 아니므로 재시도 후에도 실패하면 별도 에러 제목으로 구분한다.
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND']);
const MAX_ATTEMPTS = 3;
const SPAWN_TIMEOUT_MS = 90_000;
const BACKOFF_MS = 5_000; // attempt n 뒤에 n * BACKOFF_MS 만큼 대기
const AUDIT_ARGS = ['audit', '--omit=dev', '--json', '--fetch-timeout=30000', '--fetch-retries=2'];

/**
 * spawnSync 결과 한 번을 분류한다.
 * - ok: 파싱된 report 반환 (취약점이 있어 exit code가 0이 아니어도 ok)
 * - network: 재시도 대상 (spawn timeout, 네트워크 error code, 파싱 불가 출력)
 * - fatal: 재시도해도 소용없는 npm 오류
 * @returns {{ kind: 'ok', report: object } | { kind: 'network' | 'fatal', reason: string }}
 */
function classifyAttempt(res) {
  const spawnCode = res.error && res.error.code;
  if (spawnCode === 'ETIMEDOUT' || res.signal === 'SIGTERM') return { kind: 'network', reason: 'npm audit timed out' };
  if (spawnCode) return { kind: NETWORK_CODES.has(spawnCode) ? 'network' : 'fatal', reason: `spawn failed: ${spawnCode}` };
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    const detail = String(res.stderr || res.stdout || '').trim().slice(0, 500);
    return { kind: 'network', reason: `unparsable npm audit output ${detail}`.trim() };
  }
  if (report && report.error) {
    const code = report.error.code;
    const reason = `npm audit failed: ${report.error.summary || code}`;
    const text = `${code} ${report.error.summary || ''} ${report.error.detail || ''}`;
    const isNetwork = [...NETWORK_CODES].some((c) => text.includes(c));
    return { kind: isNetwork ? 'network' : 'fatal', reason };
  }
  return { kind: 'ok', report };
}

/** attempt 한 번을 실행하는 run()을 최대 maxAttempts번 재시도한다. network 분류만 재시도. */
function auditWithRetry(run, sleep, maxAttempts = MAX_ATTEMPTS) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = classifyAttempt(run());
    if (last.kind !== 'network') return last;
    console.error(`audit-gate: attempt ${attempt}/${maxAttempts} failed (network): ${last.reason}`);
    if (attempt < maxAttempts) sleep(attempt * BACKOFF_MS);
  }
  return last;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'audit-allowlist.json'), 'utf8'));
  const outcome = auditWithRetry(
    () => spawnSync('npm', AUDIT_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS }),
    sleepSync,
  );
  if (outcome.kind === 'network') {
    console.error(`::error title=Dependency audit (network)::npm audit unreachable after ${MAX_ATTEMPTS} attempts, not an advisory: ${outcome.reason}`);
    process.exit(2);
  }
  if (outcome.kind === 'fatal') {
    console.error(`audit-gate: ${outcome.reason}`);
    process.exit(2);
  }
  const result = evaluate(outcome.report, allowlist);
  for (const a of result.allowed) console.log(`allowlisted: ${a.id} ${a.pkg} (${a.severity}) - ${a.title}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`::error title=Dependency audit::${e}`);
    process.exit(1);
  }
  console.log(`audit-gate: ok (${result.allowed.length} allowlisted high/critical advisories)`);
}

module.exports = { collectAdvisories, evaluate, classifyAttempt, auditWithRetry };

if (require.main === module) main();
