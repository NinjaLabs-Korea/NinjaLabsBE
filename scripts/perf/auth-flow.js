// 로그인 흐름 부하(로컬 전용): exchange(PKCE, 쿠키 모드) -> refresh(쿠키) -> /auth/me. 시드된 일반 유저마다 한 흐름.
//   DATABASE_URL=... node scripts/perf/auth-flow.js <동시> <흐름수> [--base=http://127.0.0.1:4106] [--origin=<CORS_ORIGINS의 한 값>]
const { Client } = require('pg');
const { createHash, randomBytes } = require('crypto');
const flag = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || fallback;
const BASE = flag('base', 'http://127.0.0.1:4106'), ORIGIN = flag('origin', 'http://localhost:3106');
const [conc, total] = [Number(process.argv[2] || 10), Number(process.argv[3] || 200)];
const lat = { exchange: [], refresh: [], me: [] }; let bad = 0;
const pct = (a, p) => { a = [...a].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const users = (await c.query(`select id from "user" where is_admin=false order by created_at limit ${total}`)).rows;
  let i = 0;
  const one = async () => {
    for (;;) {
      const u = users[i++]; if (!u) return;
      const code = randomBytes(32).toString('base64url'), ver = randomBytes(48).toString('base64url');
      await c.query(`insert into oauth_login_code (code_hash,user_id,code_challenge) values ($1,$2,$3)`, [createHash('sha256').update(code).digest('hex'), u.id, createHash('sha256').update(ver).digest('base64url')]);
      const ip = `10.1.${i % 250}.${1 + (i * 7) % 250}`;
      const h = { 'content-type': 'application/json', origin: ORIGIN, 'x-ninja-session': 'cookie', 'x-forwarded-for': ip };
      let t = performance.now();
      const r1 = await fetch(BASE + '/auth/exchange', { method: 'POST', headers: h, body: JSON.stringify({ code, codeVerifier: ver }) });
      lat.exchange.push(performance.now() - t); const j1 = await r1.json().catch(() => ({}));
      const ck = (r1.headers.getSetCookie?.() || []).map((s) => s.split(';')[0]).join('; ');
      if (!r1.ok) { bad++; continue; }
      t = performance.now();
      const r2 = await fetch(BASE + '/auth/refresh', { method: 'POST', headers: { ...h, cookie: ck }, body: '{}' });
      lat.refresh.push(performance.now() - t); await r2.text(); if (!r2.ok) { bad++; continue; }
      t = performance.now();
      const r3 = await fetch(BASE + '/auth/me', { headers: { authorization: 'Bearer ' + j1.accessToken, 'x-forwarded-for': ip } });
      lat.me.push(performance.now() - t); await r3.text(); if (!r3.ok) bad++;
    }
  };
  const t0 = Date.now(); await Promise.all(Array.from({ length: conc }, one));
  for (const k of Object.keys(lat)) console.log(`${k.padEnd(9)} n=${lat[k].length} p50=${pct(lat[k], .5).toFixed(1)} p95=${pct(lat[k], .95).toFixed(1)} max=${Math.max(...lat[k]).toFixed(0)}`);
  console.log(`concurrency=${conc} flows=${total} failed=${bad} in ${(Date.now() - t0) / 1000}s`);
  await c.end();
})();
