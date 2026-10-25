import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { endsWithStaticFileExtension, isReservedNickname, isSavableNickname, NICKNAME, STATIC_FILE_EXTENSIONS } from './nickname';
import { CompleteProfileDto } from './users.controller';

// 컨트롤러가 서비스 → wallet-signature → @injectivelabs/sdk-ts(ESM)를 끌어오므로 서명 검증 모듈만 껍데기로 대체한다
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const failedFields = async (body: object) =>
  (await validate(plainToInstance(CompleteProfileDto, body))).map((error) => error.property).sort();

const valid = { nickname: 'ninja_dev', bio: 'Builder', tags: ['DEV'] };

describe('CompleteProfileDto', () => {
  it('accepts unicode letters/digits with _ . - and trims surrounding whitespace', async () => {
    expect(await failedFields(valid)).toEqual([]);
    expect(await failedFields({ ...valid, nickname: '닌자.개발자-01' })).toEqual([]);
    expect(await failedFields({ ...valid, nickname: '  ninja  ' })).toEqual([]);
    expect(plainToInstance(CompleteProfileDto, { ...valid, nickname: '  ninja  ' }).nickname).toBe('ninja');
  });

  it.each(['a', 'n'.repeat(51), 'ninja dev', 'ninja@dev', 'ninja/dev', 'ninja<b>', '   ', '​​'])(
    'rejects nickname %p (length 2..50, no whitespace or symbols beyond _ . -)',
    async (nickname) => {
      expect(await failedFields({ ...valid, nickname })).toEqual(['nickname']);
    },
  );

  it.each(['.ninja', 'ninja.', '-ninja', 'ninja-', '_ninja', 'ninja_', '..', '...', '--', '-.', '.-', '_-_', '.a', 'a.'])(
    'rejects nickname %p (must start and end with a letter or digit; no dot/dash-only values)',
    async (nickname) => {
      expect(await failedFields({ ...valid, nickname })).toEqual(['nickname']);
    },
  );

  it.each(['a.b', 'a-b', 'a_b', 'ninja-dev', 'n.i.n.j.a', '닌자.개발자', '01', 'me2', 'admin1', 'newbie', 'edits', 'withdrawn', 'withdrawn-1', 'unwithdrawn_1'])(
    'accepts nickname %p (letters/digits at both ends)',
    async (nickname) => {
      expect(await failedFields({ ...valid, nickname })).toEqual([]);
      expect(NICKNAME.test(nickname)).toBe(true);
    },
  );

  it.each(['me', 'ME', 'Me', 'check-nickname', 'Check-Nickname', 'admin', 'ADMIN', 'new', 'New', 'edit', 'EDIT', '  me  ', 'withdrawn_1a2b3c4d', 'Withdrawn_x'])(
    'rejects the reserved route word %p (case-insensitive)',
    async (nickname) => {
      expect(isReservedNickname(nickname)).toBe(true);
      expect(await failedFields({ ...valid, nickname })).toEqual(['nickname']);
    },
  );

  it('uses exactly the FE proxy matcher extension list (NinjaLabsFE/src/proxy.ts)', () => {
    expect(STATIC_FILE_EXTENSIONS).toEqual(['ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'txt', 'xml', 'json', 'js', 'css', 'map', 'woff', 'woff2', 'ttf']);
  });

  it.each([
    ...STATIC_FILE_EXTENSIONS.map((ext) => `ninja.${ext}`),
    ...STATIC_FILE_EXTENSIONS.map((ext) => `ninja.${ext.toUpperCase()}`),
    'Ninja.Png', 'a.b.json', '닌자.js', 'ninja.WOFF2', '  ninja.css  ',
  ])('rejects %p (ends in a static file extension the FE proxy serves as a file, case-insensitive)', async (nickname) => {
    expect(endsWithStaticFileExtension(nickname)).toBe(true);
    expect(isSavableNickname(nickname)).toBe(false);
    expect(await failedFields({ ...valid, nickname })).toEqual(['nickname']);
  });

  it.each(['ninja.jsx', 'ninja.woff3', 'ninja.pngx', 'ninja.mp4', 'ninjapng', 'ninja_png', 'ninja-json', 'png.ninja', 'js.dev', 'a.jso', 'ninja.j'])(
    'accepts %p (not one of the listed extensions, or no dot before it)',
    async (nickname) => {
      expect(endsWithStaticFileExtension(nickname)).toBe(false);
      expect(isSavableNickname(nickname)).toBe(true);
      expect(await failedFields({ ...valid, nickname })).toEqual([]);
    },
  );

  it('bounds bio to 1000 characters and still requires it', async () => {
    expect(await failedFields({ ...valid, bio: 'b'.repeat(1000) })).toEqual([]);
    expect(await failedFields({ ...valid, bio: 'b'.repeat(1001) })).toEqual(['bio']);
    expect(await failedFields({ ...valid, bio: '' })).toEqual(['bio']);
    expect(await failedFields({ ...valid, bio: '  \n\t ' })).toEqual(['bio']);
  });
});

describe('isSavableNickname (GET /users/check-nickname answers "available" only for these)', () => {
  it.each(['ninja', ' ninja ', 'ab', 'n'.repeat(50), '닌자_빌더', 'a.b-c_d'])('accepts %p, exactly what CompleteProfileDto accepts', async (nickname) => {
    expect(isSavableNickname(nickname)).toBe(true);
    expect(await failedFields({ ...valid, nickname })).toEqual([]);
  });

  it.each(['', ' ', 'a', 'n'.repeat(51), '.ninja', 'ninja-', 'has space', 'Admin', ' me '])('rejects %p, exactly what CompleteProfileDto rejects', async (nickname) => {
    expect(isSavableNickname(nickname)).toBe(false);
    expect(await failedFields({ ...valid, nickname })).toEqual(['nickname']);
  });

  it.each([undefined, null, 42, ['ninja', 'other']])('rejects the non-string %p (missing or repeated query parameter)', (value) => {
    expect(isSavableNickname(value)).toBe(false);
  });

  it('normalizes tags to a set (duplicates collapse instead of hitting the user_tag primary key)', async () => {
    expect(plainToInstance(CompleteProfileDto, { ...valid, tags: ['DEV', 'DEV', 'DESIGN', 'DEV'] }).tags).toEqual(['DEV', 'DESIGN']);
    expect(await failedFields({ ...valid, tags: ['DEV', 'DEV'] })).toEqual([]);
    expect(await failedFields({ ...valid, tags: 'DEV' })).toEqual(['tags']);
  });
});
