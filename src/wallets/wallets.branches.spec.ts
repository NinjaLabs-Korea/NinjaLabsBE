import { Logger } from '@nestjs/common';
import { Wallet } from 'ethers';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { createMockDb } from '../test-support/mock-db';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

// sdk-ts is ESM-only: use the e2e stub, which implements the two address helpers with REAL bech32 (byte-identical to sdk-ts),
// so invalid checksums / foreign prefixes are rejected exactly as in production.
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
// ADR-36 cryptography (cosmjs/noble, ESM) is replaced by a switchable verdict; its own math is out of scope here.
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const adr36 = verifyAdr36Signature as jest.MockedFunction<typeof verifyAdr36Signature>;
const userId = '11111111-1111-4111-8111-111111111111';

/** A tiny in-memory wallet_verification_challenge + wallet store behind the tx client, so tests assert on what was persisted */
function setup() {
  const challenges: Array<{ id: string; wallet_address: string; message: string; used: boolean }> = [];
  const agents: string[] = []; // wallet addresses of the user's live agents
  const wallets: Array<{ user_id: string; address: string; public_key: string | null }> = [];
  const txQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('DELETE FROM wallet_verification_challenge')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO wallet_verification_challenge')) {
      const row = { id: `c${challenges.length + 1}`, wallet_address: p[1] as string, message: p[3] as string, used: false };
      challenges.push(row);
      return { rowCount: 1, rows: [{ id: row.id, nonce: p[2], message: row.message, expires_at: 'soon' }] };
    }
    if (sql.includes('FROM wallet_verification_challenge')) {
      const found = challenges.filter((c) => c.wallet_address === p[1]).reverse();
      const best = found.find((c) => !c.used) ?? found[0];
      return best ? { rowCount: 1, rows: [{ id: best.id, message: best.message, valid: !best.used }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SET used_at = now()')) {
      const row = challenges.find((c) => c.id === p[0] && !c.used);
      if (row) row.used = true;
      return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id }] : [] };
    }
    if (sql.includes('FROM agent WHERE owner_user_id = $1')) return { rowCount: agents.length, rows: agents.map((wallet_address) => ({ wallet_address })) };
    if (sql.includes('INSERT INTO wallet ')) {
      wallets.push({ user_id: p[0] as string, address: p[1] as string, public_key: p[2] as string | null });
      return { rowCount: 1, rows: [{ id: 'wallet-id' }] };
    }
    if (sql.includes('onboarding_step')) return { rowCount: 1, rows: [] };
    throw new Error(`unexpected tx query: ${sql}`);
  });
  const query = jest.fn(async () => ({ rowCount: wallets.length, rows: wallets.length ? [{ id: 'wallet-id', chain: 'INJECTIVE', address: wallets[0].address }] : [] }));
  const { database, db } = createMockDb({ query, txQuery });
  const nfts = { enqueueParentMintInTransaction: jest.fn(async () => ({ nftId: 'nft' })) };
  return { service: new WalletsService(database, nfts as never), db, txQuery, challenges, wallets, agents, nfts };
}

beforeEach(() => adr36.mockReset().mockReturnValue(false));

describe('WalletsService address normalization (challenge + verify share it)', () => {
  const evm = Wallet.createRandom();
  const inj = getInjectiveAddress(evm.address);

  it.each([
    ['a short 0x value', '0x123'],
    ['a 0x value with a wrong EIP-55 checksum', flipChecksum(evm.address)],
    ['a non-hex 0x value', `0x${'g'.repeat(40)}`],
    ['another chain prefix', 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu'],
    ['an inj1 value with a broken checksum', `${inj.slice(0, -1)}${inj.endsWith('q') ? 'p' : 'q'}`],
    ['an inj1 value with a non-bech32 character', `${inj.slice(0, 10)}b${inj.slice(11)}`],
    ['an empty-after-trim value', '   '],
  ])('rejects %s with 400 INVALID_INJECTIVE_ADDRESS and opens no transaction', async (_label, address) => {
    const { service, db } = setup();
    await expect(service.createChallenge(userId, address)).rejects.toMatchObject({ status: 400, message: 'INVALID_INJECTIVE_ADDRESS' });
    await expect(service.verifySignature(userId, address, 'sig')).rejects.toMatchObject({ status: 400, message: 'INVALID_INJECTIVE_ADDRESS' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('trims and canonicalizes: lowercase/whitespace 0x → EIP-55 checksum; inj1 → re-encoded inj1 - in the bound params and the signed message', async () => {
    const { service, txQuery } = setup();
    const a = await service.createChallenge(userId, `  ${evm.address.toLowerCase()}\n`);
    expect(a.message).toContain(`地址: ${evm.address}`);
    const b = await service.createChallenge(userId, ` ${inj} `);
    expect(b.message).toContain(`地址: ${inj}`);
    const locks = txQuery.mock.calls.filter(([sql]) => (sql as string).includes('pg_advisory_xact_lock')).map(([, params]) => params);
    expect(locks).toEqual([[userId, evm.address], [userId, inj]]);
  });

  it('the challenge message carries a fresh 32-hex nonce and the no-gas notice', async () => {
    const { service } = setup();
    const first = await service.createChallenge(userId, evm.address);
    const second = await service.createChallenge(userId, evm.address);
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(first.nonce).not.toBe(second.nonce);
    const lines = first.message.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe(`Address / 주소 / 地址: ${evm.address}`);
    expect(lines[2]).toBe(`nonce: ${first.nonce}`);
    // every locale gets the no-gas reassurance in its own language, English first so the ASCII part is readable everywhere
    expect(lines[3]).toBe('This signature does not send a transaction and costs no gas.');
    expect(lines[4]).toContain('가스비가 들지 않습니다');
    expect(lines[5]).toContain('gas');
    expect(lines[0]).toContain('NinjaLabs wallet ownership verification');
  });
});

/** Same address with the case of the first hex letter flipped → a 0x value whose EIP-55 checksum no longer matches */
function flipChecksum(address: string): string {
  const index = [...address].findIndex((char, i) => i > 1 && /[a-fA-F]/.test(char));
  const char = address[index];
  const flipped = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
  return `${address.slice(0, index)}${flipped}${address.slice(index + 1)}`;
}

describe('WalletsService.verifySignature - ADR-36 (Keplr/Leap, inj1…)', () => {
  const evm = Wallet.createRandom();
  const inj = getInjectiveAddress(evm.address);
  const pubKey = 'A'.repeat(44);

  it('verifies against the challenge message with the supplied public key and stores the inj1 address + that key', async () => {
    const { service, challenges, wallets, nfts } = setup();
    adr36.mockReturnValue(true);
    await service.createChallenge(userId, inj);
    await expect(service.verifySignature(userId, inj, 'base64-sig', pubKey)).resolves.toEqual({ id: 'wallet-id', chain: 'INJECTIVE', address: inj });
    expect(adr36).toHaveBeenCalledWith(inj, challenges[0].message, pubKey, 'base64-sig');
    expect(wallets).toEqual([{ user_id: userId, address: inj, public_key: pubKey }]);
    expect(challenges[0].used).toBe(true);
    expect(nfts.enqueueParentMintInTransaction).toHaveBeenCalledTimes(1);
  });

  it('without a public key the ADR-36 path cannot verify: 401 INVALID_SIGNATURE, verifier not called, challenge left open', async () => {
    const { service, challenges, wallets } = setup();
    adr36.mockReturnValue(true); // would pass if it were (wrongly) consulted
    await service.createChallenge(userId, inj);
    await expect(service.verifySignature(userId, inj, 'base64-sig')).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
    expect(adr36).not.toHaveBeenCalled();
    expect(challenges[0].used).toBe(false);
    expect(wallets).toEqual([]);
  });

  it('a signature the ADR-36 verifier refuses (wrong key for the address, bad bytes) is 401 INVALID_SIGNATURE', async () => {
    const { service, wallets } = setup();
    await service.createChallenge(userId, inj);
    await expect(service.verifySignature(userId, inj, 'sig', pubKey)).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
    expect(adr36).toHaveBeenCalledTimes(1);
    expect(wallets).toEqual([]);
  });

  it('an EVM signature over the message cannot be replayed on the inj1 form of the same account (scheme follows the address form)', async () => {
    const { service } = setup();
    const challenge = await service.createChallenge(userId, inj);
    const evmSignature = await evm.signMessage(challenge.message);
    await expect(service.verifySignature(userId, inj, evmSignature)).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
  });
});

describe('WalletsService.verifySignature - EIP-191 (0x…)', () => {
  it('the challenge is keyed by the canonical 0x address: issued for the lowercase form, verified with the checksummed form', async () => {
    const signer = Wallet.createRandom();
    const { service, wallets } = setup();
    const challenge = await service.createChallenge(userId, signer.address.toLowerCase());
    await service.verifySignature(userId, signer.address, await signer.signMessage(challenge.message));
    expect(wallets.map((w) => w.address)).toEqual([getInjectiveAddress(signer.address)]);
  });

  it('a signature over an older, superseded challenge message is refused (only the latest open challenge counts)', async () => {
    const signer = Wallet.createRandom();
    const { service } = setup();
    const old = await service.createChallenge(userId, signer.address);
    await service.createChallenge(userId, signer.address);
    await expect(service.verifySignature(userId, signer.address, await signer.signMessage(old.message))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
  });

  it('stores the public key recovered from the signature, not an arbitrary key the client sent along', async () => {
    const signer = Wallet.createRandom();
    const { service, wallets } = setup();
    const challenge = await service.createChallenge(userId, signer.address);
    const forgedKey = `0x02${'ab'.repeat(32)}`;
    await service.verifySignature(userId, signer.address, await signer.signMessage(challenge.message), forgedKey);
    expect(wallets[0].public_key).toBe(signer.signingKey.compressedPublicKey);
    expect(wallets[0].public_key).not.toBe(forgedKey);
  });
});

describe('WalletsService.verifySignature - the owner\'s own agent wallet', () => {
  it('refuses to link a wallet that one of the user\'s live agents uses (400 AGENT_WALLET_IS_OWNER_WALLET), in either stored form, and consumes nothing', async () => {
    const signer = Wallet.createRandom();
    for (const stored of [signer.address, getInjectiveAddress(signer.address)]) {
      const { service, agents, wallets, nfts } = setup();
      agents.push(stored);
      const challenge = await service.createChallenge(userId, signer.address);
      await expect(service.verifySignature(userId, signer.address, await signer.signMessage(challenge.message)))
        .rejects.toMatchObject({ status: 400, message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      expect(wallets).toEqual([]);
      expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
    }
  });

  it('an agent on a different wallet does not get in the way', async () => {
    const signer = Wallet.createRandom();
    const { service, agents, wallets } = setup();
    agents.push(Wallet.createRandom().address);
    const challenge = await service.createChallenge(userId, signer.address);
    await service.verifySignature(userId, signer.address, await signer.signMessage(challenge.message));
    expect(wallets).toHaveLength(1);
  });
});

describe('WalletsService.verifySignature - concurrent withdrawal', () => {
  it('a user withdrawn between the challenge and the verify gets 404 USER_NOT_FOUND and no mint job (the wallet INSERT is rolled back with the tx)', async () => {
    const signer = Wallet.createRandom();
    const { service, txQuery, nfts } = setup();
    const challenge = await service.createChallenge(userId, signer.address);
    const original = txQuery.getMockImplementation()!;
    txQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('onboarding_step') ? { rowCount: 0, rows: [] } : original(sql, params));
    await expect(service.verifySignature(userId, signer.address, await signer.signMessage(challenge.message))).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
  });
});

describe('WalletsService.myWallet', () => {
  it('returns null when the user has no connected primary wallet', async () => {
    const { service, db } = setup();
    await expect(service.myWallet(userId)).resolves.toBeNull();
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = $1 AND is_primary = true AND disconnected_at IS NULL');
    expect(params).toEqual([userId]);
  });
});

describe('WalletsController', () => {
  function controllerSetup() {
    const wallets = {
      createChallenge: jest.fn(async () => ({ id: 'c1', nonce: 'n', message: 'm', expires_at: 'x' })),
      verifySignature: jest.fn(async () => ({ id: 'w1' })),
      myWallet: jest.fn(async () => null),
    };
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const req = { headers: {}, user: { userId, isAdmin: false } } as never;
    return { wallets, controller: new WalletsController(wallets as never), req, log, error };
  }
  afterEach(() => jest.restoreAllMocks());

  it('challenge/verify/me act for the session user and pass the body through (publicKey included)', async () => {
    const { wallets, controller, req } = controllerSetup();
    await expect(controller.challenge(req, { address: '0xabc' })).resolves.toMatchObject({ id: 'c1' });
    expect(wallets.createChallenge).toHaveBeenCalledWith(userId, '0xabc');
    await expect(controller.verify(req, { address: 'inj1abc', signature: 's', publicKey: 'pk' })).resolves.toEqual({ id: 'w1' });
    expect(wallets.verifySignature).toHaveBeenCalledWith(userId, 'inj1abc', 's', 'pk');
    await expect(controller.me(req)).resolves.toBeNull();
    expect(wallets.myWallet).toHaveBeenCalledWith(userId);
  });

  it('logs a masked address and the signature scheme, never the signature; failures are logged with the code and rethrown', async () => {
    const { wallets, controller, req, log, error } = controllerSetup();
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    await controller.verify(req, { address, signature: '0xSIGNATURE-BYTES' });
    await controller.verify(req, { address: 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', signature: 'adr' });
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.join('\n')).not.toContain('SIGNATURE-BYTES');
    expect(lines.join('\n')).not.toContain(address);
    expect(lines[0]).toContain('"wallet":"0x1234…5678"');
    expect(lines[0]).toContain('"signatureType":"EIP191"');
    expect(lines.find((line) => line.includes('inj1qq') && line.includes('verify.requested'))).toContain('"signatureType":"ADR36"');

    // 서비스는 `0X…`도 EVM으로 보고 EIP-191로 검증한다 - 로그 라벨이 같은 판정(isEvmAddress)을 써야 한다
    log.mockClear();
    await controller.verify(req, { address: '  0X1234567890abcdef1234567890abcdef12345678', signature: 's' });
    expect(String(log.mock.calls[0][0])).toContain('"signatureType":"EIP191"');

    const bad = Object.assign(new Error('INVALID_SIGNATURE'), { name: 'UnauthorizedException' });
    wallets.verifySignature.mockRejectedValueOnce(bad);
    await expect(controller.verify(req, { address, signature: 's' })).rejects.toBe(bad);
    const failure = new Error('INVALID_INJECTIVE_ADDRESS');
    wallets.createChallenge.mockRejectedValueOnce(failure);
    await expect(controller.challenge(req, { address: 'x' })).rejects.toBe(failure);
    const events = error.mock.calls.map(([line]) => JSON.parse(String(line).replace('[onboarding] ', '')));
    expect(events).toEqual([
      expect.objectContaining({ event: 'wallet.verify.failed', wallet: '0x1234…5678' }),
      expect.objectContaining({ event: 'wallet.challenge.failed', wallet: 'invalid' }),
    ]);
  });
});
