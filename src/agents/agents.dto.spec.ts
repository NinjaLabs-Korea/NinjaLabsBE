import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterAgentDto } from './agents.controller';

// 컨트롤러가 서비스 → wallet-signature / injective-public-key → @injectivelabs/sdk-ts(ESM)를 끌어오므로 서명 검증 모듈과 sdk-ts를 대체한다
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const failedFields = async (body: object) =>
  (await validate(plainToInstance(RegisterAgentDto, body))).map((error) => error.property).sort();

describe('RegisterAgentDto', () => {
  const wallet = { walletAddress: '0x1111111111111111111111111111111111111111' };

  it('bounds name to 1..100 (trimmed, matching the FE input maxLength) and description to 1000', async () => {
    expect(await failedFields({ ...wallet, name: 'n'.repeat(100), description: 'd'.repeat(1000) })).toEqual([]);
    expect(await failedFields({ ...wallet, name: 'n'.repeat(101), description: 'd'.repeat(1001) })).toEqual(['description', 'name']);
    expect(await failedFields({ ...wallet, name: '   ' })).toEqual(['name']);
    expect(plainToInstance(RegisterAgentDto, { ...wallet, name: '  bot  ' }).name).toBe('bot');
  });
});

describe('RegisterAgentDto invisible names', () => {
  const wallet = { walletAddress: '0x1111111111111111111111111111111111111111' };
  it('rejects a name made only of zero-width / filler characters but keeps a name with visible text (zero-width characters are refused anywhere in a name)', async () => {
    for (const name of ['\u200B', '\u200B\u200B', ' \u2060\uFEFF ', '\u3164']) expect(await failedFields({ ...wallet, name })).toEqual(['name']);
    expect(await failedFields({ ...wallet, name: 'bot' })).toEqual([]);
  });
});

describe('RegisterAgentDto control and bidi characters', () => {
  const wallet = { walletAddress: '0x1111111111111111111111111111111111111111' };
  it('rejects line breaks, tabs and bidirectional overrides that spoof the public profile, but keeps ordinary and emoji names', async () => {
    for (const name of ['\u202ETrusted\u202C\nAdmin Bot', 'a\nb', '\u202Eevil', 'a\tb', 'a\u2028b', 'a\u200Fb', 'a\u2066b']) {
      expect(await failedFields({ ...wallet, name })).toEqual(['name']);
    }
    for (const name of ['Trusted Admin Bot', '닌자 봇', 'bot-1_v2.0', '👩\u200D💻 coder']) expect(await failedFields({ ...wallet, name })).toEqual([]);
  });
});

describe('RegisterAgentDto names with no glyph (default-ignorable and lone combining marks)', () => {
  const wallet = { walletAddress: '0x1111111111111111111111111111111111111111' };
  it.each(['️', '️️️', '͏', '́', '឴'])('rejects %j', async (name) => {
    expect(await failedFields({ ...wallet, name })).toEqual(['name']);
  });
});
