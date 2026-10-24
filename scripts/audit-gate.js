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

function main() {
  const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'audit-allowlist.json'), 'utf8'));
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // npm audit exits non-zero when vulnerabilities exist; only unparsable output is a real failure.
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    console.error('audit-gate: could not parse npm audit output', res.stderr || res.stdout);
    process.exit(2);
  }
  if (report.error) {
    console.error(`audit-gate: npm audit failed: ${report.error.summary || report.error.code}`);
    process.exit(2);
  }
  const result = evaluate(report, allowlist);
  for (const a of result.allowed) console.log(`allowlisted: ${a.id} ${a.pkg} (${a.severity}) - ${a.title}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`::error title=Dependency audit::${e}`);
    process.exit(1);
  }
  console.log(`audit-gate: ok (${result.allowed.length} allowlisted high/critical advisories)`);
}

module.exports = { collectAdvisories, evaluate };

if (require.main === module) main();
