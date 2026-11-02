import { Logger } from '@nestjs/common';
import { Wallet } from 'ethers';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { createMockDb } from '../test-support/mock-db';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

// sdk-ts is ESM-only: use the e2e stub, which implements the two address helpers with REAL bech32 (byte-identical to sdk-ts),
// so invalid checksums / foreign prefixes are rejected exactly as in production.
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
// ADR-36 cryptography (cosmjs/noble, ESM) is not loadable here; the ADR-36 / EIP-191 verification flows run in test-db/wallets.db-spec.ts.
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

/**
 * 단위 스펙은 주소 정규화(실제 bech32/EIP-55 검사)와 챌린지 메시지 모양, 컨트롤러 로그만 본다. 챌린지 저장/소비, 서명 검증(EIP-191, ADR-36),
 * 서명 방식 선택, 복원된 공개키 저장, 에이전트 지갑 충돌, 동시 탈퇴, myWallet은 src/test-db/wallets.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드: 챌린지 발급이 내는 세 문장 말고는 `Unexpected SQL`로 실패한다.
 */
const userId = '11111111-1111-4111-8111-111111111111';

function setup() {
  const mock = createMockDb({
    strict: true,
    handlers: [
      { match: /^SELECT id FROM "user" .* FOR UPDATE$/, reply: () => ({ rowCount: 1, rows: [{ id: userId }] }) },
      { match: /^SELECT pg_advisory_xact_lock/, reply: () => ({ rowCount: 1, rows: [] }) },
      { match: /^DELETE FROM wallet_verification_challenge/, reply: () => ({ rowCount: 0, rows: [] }) },
      { match: /^INSERT INTO wallet_verification_challenge/, reply: (params) => {
        const p = params as unknown[];
        return { rowCount: 1, rows: [{ id: 'c1', nonce: p[2], message: p[3], expires_at: 'soon' }] };
      } },
    ],
  });
  const service = new WalletsService(mock.database, { enqueueParentMintInTransaction: jest.fn() } as never);
  return { service, db: mock.db, mock };
}

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
    const { service, mock } = setup();
    const a = await service.createChallenge(userId, `  ${evm.address.toLowerCase()}\n`);
    expect(a.message).toContain(`地址: ${evm.address}`);
    const b = await service.createChallenge(userId, ` ${inj} `);
    expect(b.message).toContain(`地址: ${inj}`);
    expect(mock.txStatements(/^SELECT pg_advisory_xact_lock/).map(({ params }) => params)).toEqual([[userId, evm.address], [userId, inj]]);
    expect(mock.txStatements(/^DELETE FROM wallet_verification_challenge/).map(({ params }) => params)).toEqual([[userId, evm.address], [userId, inj]]);
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
