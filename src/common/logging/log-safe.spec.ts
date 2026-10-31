import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { capLogValue, errorText, LOG_VALUE_MAX, logSafe } from './log-safe';
import { onboardingError, onboardingLog } from './onboarding-log';

const LINE_BREAK = /[\r\n\u2028\u2029]/;

describe('logSafe', () => {
  it('escapes CR/LF, other control characters and U+2028/2029 so one value can never start a new log line', () => {
    expect(logSafe('a\r\nINFO forged')).toBe('a\\r\\nINFO forged');
    expect(logSafe('x\u0000y\u001b[31m\u007f\u2028')).toBe('x\\u0000y\\u001b[31m\\u007f\\u2028');
    expect(logSafe('plain /path-ok')).toBe('plain /path-ok');
  });

  it('caps at 200 characters and says how much was cut', () => {
    expect(logSafe('a'.repeat(LOG_VALUE_MAX))).toBe('a'.repeat(LOG_VALUE_MAX));
    expect(logSafe('a'.repeat(1000))).toBe(`${'a'.repeat(LOG_VALUE_MAX)}…(+800 chars)`);
    expect(capLogValue('abcdef', 3)).toBe('abc…(+3 chars)');
  });
});

describe('errorText', () => {
  // What pg surfaces when the host resolves to both ::1 and 127.0.0.1 and neither answers: an AggregateError with an EMPTY message.
  const dualStackRefused = () => Object.assign(
    new AggregateError([new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')], ''),
    { code: 'ECONNREFUSED' },
  );

  it('returns the message when there is one, and String() for non-errors', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(undefined)).toBe('undefined');
  });

  it('spells out an AggregateError whose own message is empty (dual-stack connect failure) instead of logging nothing', () => {
    expect(dualStackRefused().message).toBe('');
    expect(errorText(dualStackRefused())).toBe('connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('falls back to the code, then the name, when neither message nor sub-errors say anything', () => {
    expect(errorText(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe('Error ETIMEDOUT');
    expect(errorText(new AggregateError([], ''))).toBe('AggregateError');
  });
});

describe('onboarding log lines', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps a user-supplied nickname with CR/LF on one line and caps it at 200 characters', () => {
    onboardingLog(new Logger('t'), 'public-profile.requested', { nickname: `evil\r\n[onboarding] {"event":"forged"}${'x'.repeat(500)}\u2028` });
    const [line] = log.mock.calls[0] as [string];
    expect(line).not.toMatch(LINE_BREAK);
    const parsed = JSON.parse(line.replace('[onboarding] ', ''));
    expect(parsed.nickname.startsWith('evil\r\n[onboarding]')).toBe(true); // escaped in the line, restored by JSON.parse
    expect(parsed.nickname.length).toBeLessThanOrEqual(LOG_VALUE_MAX + 20);
  });

  it('caps the error code taken from an exception message and the details', () => {
    onboardingError(new Logger('t'), 'profile.save.failed', new BadRequestException(`bad\n${'m'.repeat(1000)}`), { traceId: 't'.repeat(300) });
    const [line] = warn.mock.calls[0] as [string];
    expect(line).not.toMatch(LINE_BREAK);
    const parsed = JSON.parse(line.replace('[onboarding] ', ''));
    expect(parsed.errorCode.length).toBeLessThanOrEqual(LOG_VALUE_MAX + 20);
    expect(parsed.traceId.length).toBeLessThanOrEqual(LOG_VALUE_MAX + 20);
  });
});

describe('onboardingError level and rid', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs expected 4xx at warn, 5xx and non-HTTP errors at error', () => {
    onboardingError(new Logger('t'), 'x.failed', new BadRequestException('NICKNAME_TAKEN'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    onboardingError(new Logger('t'), 'x.failed', new InternalServerErrorException('boom'));
    onboardingError(new Logger('t'), 'x.failed', new Error('pool exploded'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('prints rid so the line joins the request log, and omits it when absent', () => {
    onboardingError(new Logger('t'), 'x.failed', new BadRequestException('E'), { rid: 'req-id-1234' });
    expect(JSON.parse((warn.mock.calls[0] as [string])[0].replace('[onboarding] ', '')).rid).toBe('req-id-1234');
    onboardingError(new Logger('t'), 'x.failed', new BadRequestException('E'));
    expect(JSON.parse((warn.mock.calls[1] as [string])[0].replace('[onboarding] ', ''))).not.toHaveProperty('rid');
  });
});

describe('logSafe - every input yields one bounded line', () => {
  it('escapes all 33 C0/DEL characters and U+2028/2029 to visible text', () => {
    const controls = [...Array(32).keys(), 0x7f, 0x2028, 0x2029].map((code) => String.fromCharCode(code)).join('');
    const out = logSafe(controls, 10_000);
    // eslint-disable-next-line no-control-regex -- looking for raw control characters is the point
    expect(out).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
    expect(out.startsWith('\\u0000\\u0001')).toBe(true);
    expect(out).toContain('\\n');
    expect(out).toContain('\\r');
    expect(out.endsWith('\\u007f\\u2028\\u2029')).toBe(true);
  });

  it('never emits a raw line break and never exceeds max + the truncation note (seeded generator)', () => {
    let state = 99;
    const random = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
    const alphabet = ['a', '\n', '\r', '\u2028', '\u0000', '\u001b[31m', '😀', '\\', 'é', ' '];
    for (let i = 0; i < 2000; i++) {
      let value = '';
      const parts = Math.floor(random() * 120);
      for (let j = 0; j < parts; j++) value += alphabet[Math.floor(random() * alphabet.length)];
      const out = logSafe(value, 50);
      expect(LINE_BREAK.test(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(50 + '…(+99999 chars)'.length);
    }
  });

  it.each([[null, 'null'], [undefined, 'undefined'], [42, '42'], [{ toString: () => 'x\ny' }, 'x\\ny']])('stringifies %p', (value, expected) => {
    expect(logSafe(value)).toBe(expected);
  });
});
