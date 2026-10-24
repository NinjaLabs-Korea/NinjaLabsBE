import { BadRequestException, Logger } from '@nestjs/common';
import { capLogValue, LOG_VALUE_MAX, logSafe } from './log-safe';
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

describe('onboarding log lines', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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
    const [line] = error.mock.calls[0] as [string];
    expect(line).not.toMatch(LINE_BREAK);
    const parsed = JSON.parse(line.replace('[onboarding] ', ''));
    expect(parsed.errorCode.length).toBeLessThanOrEqual(LOG_VALUE_MAX + 20);
    expect(parsed.traceId.length).toBeLessThanOrEqual(LOG_VALUE_MAX + 20);
  });
});
