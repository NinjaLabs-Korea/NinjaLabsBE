#!/usr/bin/env node
/**
 * 로컬 부하 점검 (운영에 쓰지 않는다). scripts/seed-perf.sql로 채운 DB + `node dist/main.js`로 띄운 BE에 엔드포인트별로 동시 10/50 부하를 건다.
 *   npm i --no-save autocannon
 *   DATABASE_URL=... JWT_SECRET=... node scripts/perf/load.js [이름 정규식|all] [초, 기본 8] [--base=http://127.0.0.1:4106] [--out=last.json]
 * 결과 JSON은 --out(기본 last.json)에 쓴다. p97 열은 autocannon의 97.5 백분위(p95에 가장 가까운 값).
 * 요청마다 X-Forwarded-For를 바꾼다(BE를 TRUST_PROXY=1로 띄울 것): 실제 사용자는 IP가 다양하고, 한 IP로 쏘면 IP 스로틀(600/min)이 429를 낸다.
 * BE에는 THROTTLER_STORAGE=postgres(운영과 같은 저장소)를 주고 재는 것을 권한다. 머신이 바쁘면 수치가 흔들리니 3회 이상 재고 중앙값을 쓴다.
 */
const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const flag = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || fallback;
const BASE = flag('base', 'http://127.0.0.1:4106');
const SECRET = process.env.JWT_SECRET;
if (!SECRET || !process.env.DATABASE_URL) throw new Error('DATABASE_URL and JWT_SECRET are required');
const filter = process.argv[2] && process.argv[2] !== 'all' && !process.argv[2].startsWith('--') ? new RegExp(process.argv[2]) : null;
const DUR = Number(process.argv[3] || 8);
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const rows = async (s) => (await c.query(s)).rows;
  const bounties = (await rows(`select id from bounty where deleted_at is null and status<>'DRAFT'`)).map(r => r.id);
  const notices = (await rows(`select id from notice where status='PUBLISHED' and deleted_at is null`)).map(r => r.id);
  const cohort = (await rows(`select id from cohort where name='Perf cohort 1'`))[0].id;
  const bountyAdm = (await rows(`select id from bounty where deleted_at is null limit 50`)).map(r => r.id);
  const users = await rows(`select id,is_admin,nickname from "user" where google_id in ('perf-g-1','perf-g-200','perf-g-300','perf-g-4000')`);
  const adm = users.find(u => u.is_admin);
  const tok = (u) => jwt.sign({ sub: u.id, adm: u.is_admin, typ: 'access' }, SECRET, { expiresIn: '6h' });
  const A = { authorization: 'Bearer ' + tok(adm) };
  const U = { authorization: 'Bearer ' + tok(users.find(u => !u.is_admin)) };
  await c.end();
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const nicks = Array.from({ length: 200 }, (_, i) => 'perf' + (4 + i * 20));
  const eps = [
    ['GET /bounties', () => '/bounties'],
    ['GET /bounties?status=OPEN', () => '/bounties?status=OPEN'],
    ['GET /bounties/:id', () => '/bounties/' + pick(bounties)],
    ['GET /members', () => '/members'],
    ['GET /users/:nickname', () => '/users/' + pick(nicks)],
    ['GET /notices', () => '/notices'],
    ['GET /notices/:id', () => '/notices/' + pick(notices)],
    ['GET /hall-of-fame', () => '/hall-of-fame'],
    ['GET /hall-of-fame/stats', () => '/hall-of-fame/stats'],
    ['GET /cohorts/current', () => '/cohorts/current'],
    ['AUTH GET /auth/me', () => '/auth/me', U],
    ['AUTH GET /applications/me', () => '/applications/me', U],
    ['AUTH GET /submissions/me', () => '/submissions/me', U],
    ['AUTH GET /cohorts/applications/me', () => '/cohorts/applications/me', U],
    ['ADMIN GET /admin/users?q=', () => '/admin/users?q=perf' + (100 + Math.floor(Math.random() * 90)), A],
    ['ADMIN GET /admin/users', () => '/admin/users', A],
    ['ADMIN GET /admin/bounties', () => '/admin/bounties', A],
    ['ADMIN GET /admin/bounties/:id/operations', () => `/admin/bounties/${pick(bountyAdm)}/operations`, A],
    ['ADMIN GET /admin/cohorts/:id/applications', () => `/admin/cohorts/${cohort}/applications`, A],
    ['ADMIN GET /admin/cohorts/:id/applications.csv', () => `/admin/cohorts/${cohort}/applications.csv`, A],
    ['ADMIN GET /admin/audit-logs', () => '/admin/audit-logs', A],
    ['ADMIN GET /admin/audit-logs?page=500', () => '/admin/audit-logs?page=500', A],
    ['ADMIN GET /admin/nft-jobs', () => '/admin/nft-jobs', A],
  ];
  const results = [];
  for (const [name, pathFn, hdr] of eps) {
    if (filter && !filter.test(name)) continue;
    for (const conns of [10, 50]) {
      const r = await autocannon({
        url: BASE, connections: conns, duration: DUR, timeout: 30,
        requests: [{ method: 'GET', setupRequest: (req) => { req.path = pathFn(); req.headers = { ...(hdr || {}), 'x-forwarded-for': `10.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)}.${1+Math.floor(Math.random()*250)}` }; return req; } }],
      });
      const non2xx = r.non2xx, total = r['2xx'] + non2xx;
      const row = { name, conns, rps: Math.round(r.requests.average), p50: r.latency.p50, p97: r.latency.p97_5, p99: r.latency.p99, avg: r.latency.average, max: r.latency.max, errors: r.errors + r.timeouts, non2xx, total };
      results.push(row);
      console.log(`${name.padEnd(46)} c=${String(conns).padEnd(2)} rps=${String(row.rps).padStart(5)} p50=${String(row.p50).padStart(5)} p97.5=${String(row.p97).padStart(5)} p99=${String(row.p99).padStart(5)} max=${String(row.max).padStart(5)} non2xx=${non2xx}/${total} err=${row.errors}`);
    }
  }
  require('fs').writeFileSync(flag('out', 'last.json'), JSON.stringify(results, null, 1));
})();
