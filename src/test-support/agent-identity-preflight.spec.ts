import { Wallet } from 'ethers';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { inspectIdentities, run } = require('../../scripts/check-agent-identities');

describe('read-only identity preflight before migration 0025', () => {
  const signer = Wallet.createRandom();
  const row = { id: 'one', owner_user_id: 'owner', wallet_address: signer.address, public_key: signer.signingKey.compressedPublicKey, status: 'ACTIVE', verified_at: new Date() };
  const alias = { ...row, id: 'two', owner_user_id: 'other', wallet_address: getInjectiveAddress(signer.address), public_key: Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64') };
  it('finds legacy address/key aliases without choosing an owner', () => {
    const report = inspectIdentities([row, alias]);
    expect(report.conflicts).toHaveLength(2);
    expect(report.conflicts[0]).toMatchObject({ agents: ['one', 'two'], liveCount: 2 });
  });
  it('reports verified revoked reservations held by another owner', () => {
    expect(inspectIdentities([{ ...row, status: 'REVOKED' }, alias]).conflicts[0]).toMatchObject({ reservedElsewhere: true });
  });
  it('reports ambiguous verified reservations even if every row is revoked', () => {
    expect(inspectIdentities([{ ...row, status: 'REVOKED' }, { ...alias, status: 'REVOKED' }]).conflicts[0])
      .toMatchObject({ liveCount: 0, ambiguousReservation: true });
  });
  it('allows the original owner to re-register without deleting history', () => {
    expect(inspectIdentities([{ ...row, status: 'REVOKED' }, { ...alias, owner_user_id: row.owner_user_id }]).conflicts).toEqual([]);
  });
  it('does not let unverified revoked squatters block a legitimate verified owner', () => {
    expect(inspectIdentities([row, { ...alias, status: 'REVOKED', verified_at: null }]).conflicts).toEqual([]);
  });
  it('reports unparseable addresses instead of silently rewriting them', () => {
    expect(inspectIdentities([{ ...row, wallet_address: 'legacy-invalid' }]).invalidAccounts).toEqual(['one']);
  });
  it('flags individually unique legacy cross-keys without printing key bytes', () => {
    const other = Wallet.createRandom();
    const report = inspectIdentities([
      { ...row, status: 'PENDING_VERIFICATION', verified_at: null, public_key: other.signingKey.compressedPublicKey },
      { ...row, id: 'two', wallet_address: other.address, status: 'PENDING_VERIFICATION', verified_at: null },
    ]);
    expect(report.conflicts).toEqual([]);
    expect(report.keyAddressMismatches).toEqual([
      { agent: 'one', verified: false, status: 'PENDING_VERIFICATION' },
      { agent: 'two', verified: false, status: 'PENDING_VERIFICATION' },
    ]);
    expect(JSON.stringify(report)).not.toContain(row.public_key);
  });
  it('only reads a snapshot; unsupported flags do not connect', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [row] }), release = jest.fn(), connect = jest.fn(async () => ({ query, release }));
    expect(await run([], { pool: { connect }, log: jest.fn() })).toBe(0);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN READ ONLY', expect.stringMatching(/^SELECT/), 'COMMIT', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
    connect.mockClear();
    expect(await run(['--yes'], { pool: { connect }, log: jest.fn() })).toBe(2);
    expect(connect).not.toHaveBeenCalled();
  });
});
