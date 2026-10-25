import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import { IsInt, validate } from 'class-validator';
import { CompleteProfileDto } from '../../users/users.controller';
import { isSavableNickname, NICKNAME, NICKNAME_MAX_LENGTH, RESERVED_NICKNAMES } from '../../users/nickname';
import { charLength, MaxChars } from './max-chars';
import { MaxPgInt, PG_INT_MAX } from './optional-not-null';
import { TOKEN_AMOUNT } from './token-amount';
import { normalizeTxHash, TX_HASH } from './tx-hash';
import { isHttpUrl, isMediaPath, isSafeUrl, isSitePath } from './url';

/**
 * Property-style table tests for every input validator — adversarial inputs (homoglyphs, invisible and bidi characters, encodings,
 * boundary lengths) plus seeded generated inputs checked against an independent oracle, and a timing guard so a regex change that
 * introduces catastrophic backtracking fails here instead of pinning a CPU on a public route.
 */

/** Deterministic PRNG (mulberry32) — generated cases are reproducible; the seed is in the test name */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function generate(random: () => number, alphabet: readonly string[], maxParts: number): string {
  const parts = 1 + Math.floor(random() * maxParts);
  let out = '';
  for (let i = 0; i < parts; i++) out += pick(random, alphabet);
  return out;
}

/**
 * Fails if `fn` takes longer than `budgetMs` on every one of a few tries — the budget is ~100x the measured time, so only super-linear
 * blow-ups trip it. A real ReDoS is slow every time; a GC pause or a busy CI core under parallel Jest workers slows one try at most.
 */
function expectFast(label: string, fn: () => unknown, budgetMs = 50, tries = 3): void {
  let best = Infinity;
  for (let i = 0; i < tries && best > budgetMs; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  if (best > budgetMs) throw new Error(`${label} took ${best.toFixed(1)}ms (budget ${budgetMs}ms) — possible ReDoS`);
}

const MEDIA = '/media/11111111-1111-4111-8111-111111111111';

describe('URL validators — adversarial table', () => {
  it.each([
    // [input, isHttpUrl, isSitePath, isSafeUrl, isMediaPath]
    ['https://ninjalabs.xyz', true, false, true, false],
    ['https://xn--n3h.com', true, false, true, false], // punycode host
    ['https://例え.jp/', true, false, true, false], // IDN host
    ['https://[::1]:3000/', true, false, true, false], // IPv6 literal
    ['http://a', true, false, true, false], // single-label host (require_tld: false for localhost previews)
    ['https://example.com:99999', false, false, false, false], // port out of range
    ['https://example.com:0', false, false, true, false], // port 0: URL accepts, isURL rejects — lenient rule keeps legacy
    ['https://exa mple.com', false, false, false, false],
    ['https://example.com/ ', false, false, false, false],
    [' https://example.com', false, false, false, false],
    ['https://example.com#\n', false, false, false, false],
    ['https://a..b', false, false, true, false],
    ['https://-a.com', false, false, true, false],
    ['https://example.com\\@evil.com', false, false, false, false], // backslash — WHATWG reads it as a path separator
    ['https://evil.com\\.example.com', false, false, false, false],
    ['https://user@evil.com', false, false, false, false],
    ['https://ninjalabs.xyz%40evil.com@evil.com', false, false, false, false],
    ['JAVASCRIPT:alert(1)', false, false, false, false],
    ['java\u0000script:alert(1)', false, false, false, false],
    ['javascript://example.com/%0aalert(1)', false, false, false, false],
    ['\u0000https://example.com', false, false, false, false],
    ['https:\\\\evil.com', false, false, false, false],
    ['//evil.com', false, false, false, false],
    ['/\\evil.com', false, false, false, false],
    ['/\t/evil.com', false, false, false, false], // browsers strip tab/newline inside URLs → //evil.com
    ['/\n/evil.com', false, false, false, false],
    ['/%2f/evil.com', false, false, true, false], // lenient: legacy, not a scheme
    [MEDIA, false, true, true, true],
    [`${MEDIA}\n`, false, false, false, false],
    [`${MEDIA.toUpperCase()}`, false, true, true, true],
    ['/media/11111111-1111-4111-8111-11111111111g', false, true, true, false],
    ['/a/%2E/b', false, false, true, false],
    ['/a/%2e%2E', false, false, true, false],
    ['/a/%c0%ae%c0%ae/b', false, false, true, false], // overlong UTF-8 dot — malformed percent sequence
    ['/a/.%00./', false, false, true, false],
    ['/;/..', false, false, true, false],
    ['/..%3b/', false, false, true, false],
    ['/a/.../b', false, true, true, false], // three dots is an ordinary segment
    ['/a?x=..', false, true, true, false], // query is not a path segment
    ['/a#/../b', false, true, true, false],
    ['/\u00a0', false, false, true, false], // NBSP counts as whitespace for SITE_PATH
    ['ex_ample.com', false, false, false, false],
    ['example.co\u200b.uk', false, false, false, false], // zero-width space in a bare host
    ['localhost:3000', false, false, false, false],
    ['', false, false, false, false],
  ] as const)('%p → http %p / site %p / safe %p / media %p', (input, http, site, safe, media) => {
    expect([isHttpUrl(input), isSitePath(input), isSafeUrl(input), isMediaPath(input)]).toEqual([http, site, safe, media]);
  });

  it.each([42, null, undefined, {}, [], ['https://a.com'], new String('https://a.com'), true])('non-string %p is rejected by every URL validator', (input) => {
    expect([isHttpUrl(input), isSitePath(input), isSafeUrl(input), isMediaPath(input)]).toEqual([false, false, false, false]);
  });

  it('length cap is exactly 2048 for http, site and lenient rules', () => {
    const http = (n: number) => `https://a.com/${'a'.repeat(n - 'https://a.com/'.length)}`;
    const site = (n: number) => `/${'a'.repeat(n - 1)}`;
    expect([isHttpUrl(http(2048)), isHttpUrl(http(2049))]).toEqual([true, false]);
    expect([isSitePath(site(2048)), isSitePath(site(2049))]).toEqual([true, false]);
    expect([isSafeUrl(site(2048)), isSafeUrl(site(2049))]).toEqual([true, false]);
  });

  it('every strict-rule value also passes the lenient update rule (seed 7) — an update must never reject what create accepted', () => {
    const random = prng(7);
    const alphabet = ['a', 'Z', '0', '-', '_', '.', '..', '/', '//', '?', '#', '=', '&', '%2e', '%2f', '%41', '%', ';', ':', '@', '\\', ' ', '\t', '\u0000', '😀', 'é'];
    const prefixes = ['https://a.com', 'http://localhost:3000', '/', '/media/', 'https://', 'cdn.example', ''];
    let strictPasses = 0;
    for (let i = 0; i < 3000; i++) {
      const value = pick(random, prefixes) + generate(random, alphabet, 12);
      const strict = isHttpUrl(value) || isSitePath(value) || isMediaPath(value);
      if (strict) {
        strictPasses++;
        expect({ value, lenient: isSafeUrl(value) }).toEqual({ value, lenient: true });
      }
    }
    expect(strictPasses).toBeGreaterThan(300); // the generator actually exercises the accepting side
  });

  it('accepted values are never executable or protocol-relative (seed 11)', () => {
    const random = prng(11);
    const alphabet = ['javascript:', 'data:', 'vbscript:', 'JaVaScRiPt:', '//', '/\\', '\\', '/', 'a', '.', 'com', ':', '\t', '\n', ' ', '%0a', 'https:', 'http://'];
    for (let i = 0; i < 3000; i++) {
      const value = generate(random, alphabet, 8);
      if (!isSafeUrl(value)) continue;
      // What a browser would resolve the value to against our origin: must stay http(s), and a relative value must stay on our host
      const resolved = new URL(value, 'https://ninjalabs.xyz/base/');
      expect({ value, protocol: resolved.protocol }).toEqual({ value, protocol: expect.stringMatching(/^https?:$/) });
      if (value.startsWith('/')) expect({ value, host: resolved.host }).toEqual({ value, host: 'ninjalabs.xyz' });
    }
  });

  it('site paths that pass never resolve outside the path they name (seed 13)', () => {
    const random = prng(13);
    const alphabet = ['a', 'b', '/', '.', '..', '%2e', '%2E', ';', '%3b', '%', '2e', '?', '#', '%00', '%2f', '~', '-'];
    for (let i = 0; i < 5000; i++) {
      const value = `/${generate(random, alphabet, 10)}`;
      if (!isSitePath(value)) continue;
      const resolved = new URL(value, 'https://ninjalabs.xyz').pathname;
      const decodedSegments = resolved.split('/').map((segment) => decodeURIComponent(segment.split(';')[0]));
      expect({ value, dotSegments: decodedSegments.filter((s) => s === '.' || s === '..') }).toEqual({ value, dotSegments: [] });
    }
  });
});

describe('nickname — adversarial table', () => {
  it.each([
    ['ab', true],
    ['a', false],
    ['a'.repeat(NICKNAME_MAX_LENGTH), true],
    ['a'.repeat(NICKNAME_MAX_LENGTH + 1), false],
    ['  ab  ', true], // trimmed like the DTO's @Trim()
    ['ab\n', true],
    ['닌자', true],
    ['٣٣', true], // Arabic-Indic digits are \p{N}
    ['Ⅻx', true], // letter-number
    ['a.b-c_d', true],
    ['a..b', true], // inner dots are fine — only leading/trailing dots make "." / ".." segments
    ['😀😀', false], // emoji is neither \p{L} nor \p{N}
    ['❤\ufe0f❤\ufe0f', false], // U+FE0F is a mark, not allowed
    ['ninja\u0301', true], // composes to á under NFC
    ['ninj\u0301', false], // no precomposed form: the combining mark stays and ends the nickname
    ['a b', false],
    ['a\u200bb', false], // zero-width space
    ['a\u202eb', false], // bidi override
    ['a\u0000b', false],
    ['a\nb', false],
    ['a/b', false],
    ['a%2fb', false],
    ['.ninja', false],
    ['ninja.', false],
    ['..', false],
    ['a_', false],
    ['_a', false],
    ['-ab', false],
    ['ME', false],
    [' admin ', false],
    ['Check-Nickname', false],
    ['NEW', false],
    ['Edit', false],
    ['ninja.png', false], // FE proxy treats it as a static file
    ['Ninja.JSON', false],
    ['ninja.jsx', true],
  ])('%p savable → %p', (input, expected) => {
    expect(isSavableNickname(input)).toBe(expected);
  });

  it.each([42, null, undefined, ['ab'], { toString: () => 'ab' }])('non-string %p is never savable', (input) => {
    expect(isSavableNickname(input)).toBe(false);
  });

  /** check-nickname answers "available" only for values POST /users/me/profile would store — the two must never disagree */
  async function dtoAccepts(nickname: string): Promise<boolean> {
    const errors = await validate(plainToInstance(CompleteProfileDto, { nickname, bio: 'b', tags: ['DEV'] }));
    return !errors.some((error) => error.property === 'nickname');
  }

  it('isSavableNickname agrees with the CompleteProfileDto validation on every table value and every reserved word variant', async () => {
    const values = [
      'ab', 'a', 'a'.repeat(50), 'a'.repeat(51), '  ab  ', '닌자', '😀😀', '😀a', 'a😀b', '❤\ufe0f❤\ufe0f', 'ab\u0301', 'a..b', '.ab', 'ab.', 'a b',
      `${'가'.repeat(49)}😀`, '가'.repeat(50), '가'.repeat(51), ' x ', 'x', 'ab\u200b',
      'ninja.png', 'ninja.PNG', 'a.b.json', 'ninja.jsx', 'ninja.woff2', ' ninja.css ',
      ...RESERVED_NICKNAMES.flatMap((word) => [word, word.toUpperCase(), ` ${word} `]),
    ];
    for (const value of values) {
      expect({ value, dto: await dtoAccepts(value) }).toEqual({ value, dto: isSavableNickname(value) });
    }
  });

  it('agrees with the DTO on generated inputs (seed 3)', async () => {
    const random = prng(3);
    const alphabet = ['a', 'Z', '9', '가', '٣', '_', '.', '-', ' ', '😀', '\u0301', '\ufe0f', '\u200b', 'me', 'admin', '/', 'é', 'ß'];
    for (let i = 0; i < 400; i++) {
      const value = generate(random, alphabet, 30);
      expect({ value, dto: await dtoAccepts(value) }).toEqual({ value, dto: isSavableNickname(value) });
    }
  });

  it('every savable nickname is a single, non-dot URL path segment that round-trips through encodeURIComponent (seed 5)', () => {
    const random = prng(5);
    const alphabet = ['a', 'Z', '9', '가', '_', '.', '-', '..', '%', '/', '?', '#', 'é'];
    let savable = 0;
    for (let i = 0; i < 3000; i++) {
      const value = generate(random, alphabet, 12);
      if (!isSavableNickname(value)) continue;
      savable++;
      const pathname = new URL(`/users/${encodeURIComponent(value)}`, 'https://ninjalabs.xyz').pathname;
      expect(decodeURIComponent(pathname)).toBe(`/users/${value}`);
    }
    expect(savable).toBeGreaterThan(100);
  });
});

describe('tx hash — adversarial table', () => {
  const hex = 'ab'.repeat(32);

  it.each([
    [hex, `0x${hex}`],
    [hex.toUpperCase(), `0x${hex}`],
    [`0x${hex.toUpperCase()}`, `0x${hex}`],
    [`${hex}\n`, `0x${hex}`], // trim() strips trailing newline before the anchored test
    [`\u00a0${hex}`, `0x${hex}`], // and NBSP (String#trim covers Unicode spaces)
    [`\ufeff0x${hex}`, `0x${hex}`], // BOM pasted from a spreadsheet
  ])('accepts %p → %p', (input, expected) => {
    expect(normalizeTxHash(input)).toBe(expected);
  });

  it.each([
    `0x${'٣'.repeat(64)}`, // non-ASCII digits
    `0x${'ａ'.repeat(64)}`, // fullwidth letters
    `0x${hex.slice(0, 63)}`,
    `0x0x${hex}`,
    `x${hex}`,
    `0x${hex}\u200b`, // zero-width space is not trimmed
    `0x${hex.slice(0, 32)} ${hex.slice(32)}`,
    `${hex}${hex}`,
    `0x${hex}\u0000`,
  ])('rejects %p with 400 INVALID_TX_HASH', (input) => {
    expect(() => normalizeTxHash(input)).toThrow(new BadRequestException('INVALID_TX_HASH'));
  });

  it('normalizes generated 32-byte hashes to one canonical form regardless of case and prefix (seed 17)', () => {
    const random = prng(17);
    const digits = '0123456789abcdefABCDEF';
    for (let i = 0; i < 500; i++) {
      let raw = '';
      for (let j = 0; j < 64; j++) raw += digits[Math.floor(random() * digits.length)];
      const variant = random() < 0.5 ? `0x${raw}` : raw;
      const normalized = normalizeTxHash(variant);
      expect(normalized).toMatch(/^0x[0-9a-f]{64}$/);
      expect(normalized).toBe(`0x${raw.toLowerCase()}`);
      expect(normalizeTxHash(normalized)).toBe(normalized); // idempotent
      expect(TX_HASH.test(normalized)).toBe(true);
    }
  });
});

describe('token amount — adversarial table', () => {
  it.each([
    ['1', true], ['10', true], ['1'.repeat(78), true], ['9'.repeat(78), true],
    ['0', false], ['00', false], ['01', false], ['1'.repeat(79), false], ['-1', false], ['+1', false], ['1.0', false], ['1e18', false],
    ['0x10', false], [' 1', false], ['1 ', false], ['1\n', false], ['１', false], ['٣', false], ['1_000', false], ['1,000', false], ['', false],
  ])('%p → %p', (input, expected) => {
    expect(TOKEN_AMOUNT.test(input)).toBe(expected);
  });

  it('accepted amounts are canonical integers that fit DECIMAL(78,0) (seed 19)', () => {
    const random = prng(19);
    const alphabet = ['0', '1', '9', '5', '00', '.', 'e', '-', ' '];
    const max = 10n ** 78n - 1n;
    for (let i = 0; i < 3000; i++) {
      const value = generate(random, alphabet, 90);
      if (!TOKEN_AMOUNT.test(value)) continue;
      const amount = BigInt(value);
      expect(amount.toString()).toBe(value); // no leading zeros, no sign, no exponent
      expect(amount > 0n && amount <= max).toBe(true);
    }
  });
});

describe('MaxChars — counts code points like Postgres char_length()', () => {
  class Probe { @MaxChars(5) value!: unknown; }
  const passes = async (value: unknown) => (await validate(plainToInstance(Probe, { value }))).length === 0;

  it.each([
    ['abcde', 5, true],
    ['abcdef', 6, false],
    ['❤\ufe0f❤\ufe0f', 4, true], // 2 × (U+2764 U+FE0F)
    ['❤\ufe0f❤\ufe0f❤\ufe0f', 6, false], // class-validator MaxLength would count 3 and pass it
    ['\ufe0f'.repeat(5), 5, true],
    ['\ufe0f'.repeat(6), 6, false],
    ['\ufe0e'.repeat(6), 6, false], // text presentation selector — also dropped by validator.js isLength
    ['😀'.repeat(5), 5, true], // astral = one code point (two UTF-16 units)
    ['😀'.repeat(6), 6, false],
    ['👨\u200d👩\u200d👧', 5, true], // ZWJ family: 3 emoji + 2 ZWJ = 5 code points, one grapheme
    ['👨\u200d👩\u200d👧\u200d👦', 7, false],
    ['e\u0301'.repeat(3), 6, false], // combining acute counts separately
    ['\ud800abcd', 5, true], // lone surrogate counts as one
    ['', 0, true],
  ])('%p has %p code points → passes MaxChars(5): %p', async (value, length, ok) => {
    expect(charLength(value)).toBe(length);
    expect(await passes(value)).toBe(ok);
  });

  it('charLength equals the Unicode code point count for generated strings (seed 23)', async () => {
    const random = prng(23);
    const alphabet = ['a', 'é', 'e\u0301', '❤\ufe0f', '\ufe0f', '😀', '\u200d', '가', '\ud83d', '\ude00', ' '];
    for (let i = 0; i < 1000; i++) {
      const value = generate(random, alphabet, 8);
      let codePoints = 0;
      for (let j = 0; j < value.length; j++) {
        const unit = value.charCodeAt(j);
        const next = value.charCodeAt(j + 1);
        if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) j++;
        codePoints++;
      }
      expect({ value, length: charLength(value) }).toEqual({ value, length: codePoints });
      expect({ value, ok: await passes(value) }).toEqual({ value, ok: codePoints <= 5 });
    }
  });

  it.each([123, null, undefined, ['abcdefgh'], { length: 1 }])('leaves non-string %p to @IsString()', async (value) => {
    expect(await passes(value)).toBe(true);
  });
});

describe('MaxPgInt — Postgres INTEGER upper bound', () => {
  class Probe { @Type(() => Number) @IsInt() @MaxPgInt() value!: number; }
  const failures = async (value: unknown) =>
    (await validate(plainToInstance(Probe, { value }))).flatMap((error) => Object.keys(error.constraints ?? {})).sort();

  it.each([
    [PG_INT_MAX, []],
    [String(PG_INT_MAX), []],
    [-PG_INT_MAX - 1, []], // lower bound is the caller's @Min
    [0, []],
    [PG_INT_MAX + 1, ['max']],
    [String(PG_INT_MAX + 1), ['max']],
    [2 ** 32, ['max']],
    [Number.MAX_SAFE_INTEGER, ['max']],
    ['1e10', ['max']],
    [Infinity, ['isInt', 'max']],
    [1.5, ['isInt']],
    ['abc', ['isInt', 'max']], // NaN fails both — class-validator's max() is `value <= max`, false for NaN
    ['0x7fffffff', []], // hex string → 2147483647 via Number()
    ['0x80000000', ['max']],
  ])('%p → failed constraints %p', async (value, expected) => {
    expect(await failures(value)).toEqual(expected);
  });

  it('the constant is 2^31 − 1', () => {
    expect(PG_INT_MAX).toBe(2 ** 31 - 1);
  });
});

describe('ReDoS timing guard', () => {
  const N = 200_000;
  const cases: Array<[string, () => unknown]> = [
    ['NICKNAME a + "-"×N + "!"', () => NICKNAME.test(`a${'-'.repeat(N)}!`)],
    ['NICKNAME "a."×N + "!"', () => NICKNAME.test(`${'a.'.repeat(N)}!`)],
    ['NICKNAME "가"×N + "😀"', () => NICKNAME.test(`${'가'.repeat(N)}😀`)],
    ['isSavableNickname huge', () => isSavableNickname(`a${'_'.repeat(N)}!`)],
    ['CompleteProfileDto regex on a huge nickname', () => NICKNAME.test(`${'a-'.repeat(N)}`)],
    ['isSafeUrl bare host "a."×1000', () => isSafeUrl(`${'a.'.repeat(1000)}!`)],
    ['isSafeUrl bare host near-63 labels', () => isSafeUrl(`${`${'a'.repeat(62)}.`.repeat(32)}1`)],
    ['isSafeUrl bare host "a-"×1000', () => isSafeUrl(`${'a-'.repeat(1000)}.`)],
    ['isSafeUrl huge (length cap)', () => isSafeUrl(`/${'a'.repeat(N)}`)],
    ['isHttpUrl "a."×1015', () => isHttpUrl(`https://${'a.'.repeat(1015)}!`)],
    ['isHttpUrl "a-"×1015', () => isHttpUrl(`https://${'a-'.repeat(1015)}`)],
    ['isHttpUrl "%"×2030', () => isHttpUrl(`https://a.com/${'%'.repeat(2030)}`)],
    ['isHttpUrl ":"×2000', () => isHttpUrl(`http://${':'.repeat(2000)}`)],
    ['isHttpUrl long label', () => isHttpUrl(`https://${'a'.repeat(64)}.${'b'.repeat(1900)}.com`)],
    ['isHttpUrl huge (length cap)', () => isHttpUrl(`https://${'a.'.repeat(N)}`)],
    ['isSitePath "../"×680', () => isSitePath(`/${'../'.repeat(680)}`)],
    ['isSitePath "a/"×1020', () => isSitePath(`/${'a/'.repeat(1020)}`)],
    ['isSitePath ";"×2040', () => isSitePath(`/${';'.repeat(2040)}`)],
    ['isSitePath "%2"×680', () => isSitePath(`/${'%2'.repeat(680)}`)],
    ['isMediaPath huge', () => isMediaPath(`/media/${'a'.repeat(N)}`)],
    ['TOKEN_AMOUNT "1"×N + "x"', () => TOKEN_AMOUNT.test(`${'1'.repeat(N)}x`)],
    ['TX_HASH "a"×N', () => TX_HASH.test(`0x${'a'.repeat(N)}`)],
    ['normalizeTxHash padded', () => { try { normalizeTxHash(`${' '.repeat(N)}${'a'.repeat(N)}`); } catch { /* 400 expected */ } }],
    ['charLength "❤\ufe0f"×N', () => charLength('❤\ufe0f'.repeat(N))],
  ];

  it.each(cases)('%s stays linear', (label, fn) => {
    fn(); // warm up the regex compiler / JIT so the budget measures matching, not compilation
    expectFast(label, fn);
  });
});
