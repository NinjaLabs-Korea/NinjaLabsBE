#!/usr/bin/env node
// Read-only preflight, including before 0025 exists. Never rewrites owners, keys or history.
const { getEthereumAddress } = require('@injectivelabs/sdk-ts');
const { getAddress, computeAddress } = require('ethers');
const { runCli } = require('./ops-cli');

function accountKey(address) {
  try { return getAddress(/^0x/i.test(address) ? address : getEthereumAddress(address)).toLowerCase(); }
  catch { return null; }
}
function publicKeyId(value) {
  if (!value) return null;
  if (/^0x0[23][0-9a-f]{64}$/i.test(value)) return value.slice(2).toLowerCase();
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 33 && [2, 3].includes(bytes[0]) ? bytes.toString('hex') : null;
}
function inspectIdentities(rows) {
  const groups = { account: new Map(), publicKey: new Map() };
  const invalid = [];
  const mismatches = [];
  for (const row of rows) {
    const account = accountKey(row.wallet_address);
    if (!account) invalid.push(row.id);
    if (row.public_key) {
      let keyAccount = null;
      try { const key = publicKeyId(row.public_key); if (key) keyAccount = computeAddress('0x' + key).toLowerCase(); } catch { /* invalid legacy key */ }
      if (!keyAccount || keyAccount !== account) mismatches.push({ agent: row.id, verified: !!row.verified_at, status: row.status });
    }
    for (const [kind, value] of [['account', account ?? row.wallet_address], ['publicKey', publicKeyId(row.public_key) ?? row.public_key]]) {
      if (!value) continue;
      const group = groups[kind].get(value) ?? [];
      group.push(row);
      groups[kind].set(value, group);
    }
  }
  const conflicts = [];
  for (const [kind, values] of Object.entries(groups)) {
    for (const group of values.values()) {
      const live = group.filter((row) => row.status !== 'REVOKED');
      const owners = new Set(group.map((row) => row.owner_user_id));
      const reservedOwners = new Set(group.filter((row) => row.verified_at).map((row) => row.owner_user_id));
      const reservedElsewhere = live.some((row) => reservedOwners.size > 1 || (reservedOwners.size === 1 && !reservedOwners.has(row.owner_user_id)));
      const ambiguousReservation = reservedOwners.size > 1;
      if (live.length > 1 || reservedElsewhere || ambiguousReservation) conflicts.push({ kind, agents: group.map((row) => row.id), owners: [...owners], liveCount: live.length, reservedElsewhere, ambiguousReservation });
    }
  }
  return { conflicts, invalidAccounts: invalid, keyAddressMismatches: mismatches };
}
async function run(argv, { pool, log = console.log }) {
  if (argv.length) { log('usage: node scripts/check-agent-identities.js (read-only; no flags)'); return 2; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query('SELECT id, owner_user_id, wallet_address, public_key, status, verified_at FROM agent WHERE deleted_at IS NULL');
    const report = inspectIdentities(rows);
    await client.query('COMMIT');
    log(JSON.stringify(report, null, 2)); // no signatures, API keys or private keys are selected
    return report.conflicts.length || report.invalidAccounts.length || report.keyAddressMismatches.length ? 1 : 0;
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
if (require.main === module) runCli(run);
module.exports = { accountKey, publicKeyId, inspectIdentities, run };
