import { ArgumentsHost, HttpException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { AlertService } from '../alerts/alert.service';
import { HTTP_5XX_BURST_THRESHOLD, HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        path: '/admin/bounties',
        url: '/admin/bounties?secret=1',
        headers: { authorization: 'Bearer token' },
        body: { refreshToken: 'secret-token' },
      }),
    }),
  } as unknown as ArgumentsHost;

  let base: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    base = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('delegates the response to the Nest base filter unchanged', () => {
    const exception = new NotFoundException('BOUNTY_NOT_FOUND');
    new HttpExceptionFilter().catch(exception, host);
    expect(base).toHaveBeenCalledWith(exception, host);
    expect(error).not.toHaveBeenCalled();
  });

  it('logs method, path, status and error for 5xx without body, headers or query string', () => {
    new HttpExceptionFilter().catch(new Error('connection terminated'), host);
    new HttpExceptionFilter().catch(new ServiceUnavailableException({ status: 'degraded' }), host);

    expect(error).toHaveBeenCalledTimes(2);
    const [unknownLine] = error.mock.calls[0] as [string];
    expect(unknownLine).toBe('POST /admin/bounties 500 Error: connection terminated');
    const [httpLine] = error.mock.calls[1] as [string];
    expect(httpLine).toContain('POST /admin/bounties 503 ServiceUnavailableException');
    for (const [line] of error.mock.calls as [string][]) {
      expect(line).not.toContain('secret');
      expect(line).not.toContain('Bearer');
    }
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('answers 400 INVALID_CHARACTER (no error log) when Postgres rejects a character in the request value (NUL → 22021)', () => {
    const pgError = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
    new HttpExceptionFilter().catch(pgError, host);
    expect(error).not.toHaveBeenCalled();
    const [sent] = base.mock.calls[0] as [HttpException];
    expect(sent).toBeInstanceOf(HttpException);
    expect(sent.getStatus()).toBe(400);
    expect(sent.getResponse()).toMatchObject({ message: 'INVALID_CHARACTER' });
  });

  it('logs the sub-error messages when the database error has an empty message (dual-stack ECONNREFUSED AggregateError) - the 503 line must not end in a bare ": "', () => {
    const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')], ''), { code: 'ECONNREFUSED' });
    new HttpExceptionFilter().catch(refused, host);
    const [sent] = base.mock.calls[0] as [HttpException];
    expect(sent.getResponse()).toMatchObject({ statusCode: 503, message: 'DATABASE_UNAVAILABLE' });
    expect(error.mock.calls[0][0]).toBe('POST /admin/bounties 503 AggregateError: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  it.each(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'])(
    'answers 503 DATABASE_UNAVAILABLE for a pool connect timeout (%s) and logs the original cause',
    (message) => {
      new HttpExceptionFilter().catch(new Error(message), host);
      const [sent] = base.mock.calls[0] as [HttpException];
      expect(sent).toBeInstanceOf(ServiceUnavailableException);
      expect(sent.getResponse()).toMatchObject({ statusCode: 503, message: 'DATABASE_UNAVAILABLE' });
      expect(error.mock.calls[0][0]).toBe(`POST /admin/bounties 503 Error: ${message}`);
    },
  );

  it('treats non-HttpException throwables as 500 and HttpException status as given', () => {
    new HttpExceptionFilter().catch(new HttpException('TEAPOT', 418), host);
    expect(error).not.toHaveBeenCalled();
    new HttpExceptionFilter().catch('string failure', host);
    expect(error).toHaveBeenCalledWith('POST /admin/bounties 500 UnknownError: string failure');
  });

  it.each([
    ['entity.parse.failed (malformed JSON)', Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400, statusCode: 400, type: 'entity.parse.failed', expose: true })],
    ['entity.too.large', Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, type: 'entity.too.large', expose: true })],
    ['statusCode only', Object.assign(new Error('bad'), { statusCode: 422 })],
  ])('does not log body-parser style 4xx errors that are not HttpException: %s', (_label, exception) => {
    new HttpExceptionFilter().catch(exception, host);
    expect(error).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledWith(exception, host);
  });

  it('still logs plain errors whose carried status is outside 4xx or not numeric', () => {
    new HttpExceptionFilter().catch(Object.assign(new Error('upstream'), { statusCode: 502 }), host);
    new HttpExceptionFilter().catch(Object.assign(new Error('weird'), { statusCode: '400' }), host);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toBe('POST /admin/bounties 502 Error: upstream');
    expect(HttpExceptionFilter.statusOf(null)).toBe(500);
  });

  it('logs an upstream-client error that carries only `status` (gaxios/undici): the response is a 500, so the log must be too', () => {
    const upstream = Object.assign(new Error('invalid_grant'), { status: 400 });
    new HttpExceptionFilter().catch(upstream, host);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('POST /admin/bounties 500 Error: invalid_grant');
  });

  it('adds the stack frames (never the message line) as the Nest stack argument, so a 5xx stays diagnosable', () => {
    new HttpExceptionFilter().catch(new Error('boom\n    at forged (/etc/passwd:1:1)'), host);
    const [line, stack] = error.mock.calls[0] as [string, string];
    expect(line).toBe('POST /admin/bounties 500 Error: boom\\n    at forged (/etc/passwd:1:1)');
    expect(stack.split('\n')[0]).toBe('Error');
    expect(stack).toMatch(/\n\s+at .*http-exception\.filter\.spec\.ts:\d+:\d+/);
    expect(stack.split('\n').length).toBeLessThanOrEqual(13);
  });

  it('escapes CR/LF and caps user-influenced path and message in the 5xx line', () => {
    const forging = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', path: '/users/x\r\nFAKE 200 OK' }) }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(new Error(`duplicate key value (${'v'.repeat(1000)})\nsecond line`), forging);
    const [line] = error.mock.calls[0] as [string];
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('/users/x\\r\\nFAKE 200 OK');
    expect(line.length).toBeLessThan(600);
    expect(line).toMatch(/…\(\+\d+ chars\)$/);
  });

  describe('5xx burst ops alert', () => {
    const routed = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', path: '/bounties/3f0c-secret-slug', route: { path: '/bounties/:id' }, body: { email: 'a@b.co' } }),
      }),
    } as unknown as ArgumentsHost;

    function filterWithClock() {
      const alerts = { notify: jest.fn(async () => true) };
      let clock = 0;
      const filter = new HttpExceptionFilter(undefined, alerts as unknown as AlertService, () => clock);
      return { filter, alerts, advance: (ms: number) => { clock += ms; } };
    }

    it(`alerts once the ${HTTP_5XX_BURST_THRESHOLD + 1}th 5xx lands inside 5 minutes, with the route pattern and error name only`, () => {
      const { filter, alerts, advance } = filterWithClock();
      for (let i = 0; i < HTTP_5XX_BURST_THRESHOLD; i++) { filter.catch(new Error(`db said ${i} a@b.co`), routed); advance(1000); }
      expect(alerts.notify).not.toHaveBeenCalled();
      filter.catch(new Error('db said a@b.co'), routed);
      expect(alerts.notify).toHaveBeenCalledTimes(1);
      const [key, message] = (alerts.notify.mock.calls as unknown as [string, string][])[0];
      expect(key).toBe('http-5xx-burst');
      expect(message).toBe('more than 20 5xx responses in the last 5 min - latest: GET /bounties/:id 500 Error');
      expect(message).not.toContain('secret-slug');
      expect(message).not.toContain('a@b.co');
    });

    it('does not count 4xx and does not alert for a slow trickle of 5xx', () => {
      const { filter, alerts, advance } = filterWithClock();
      for (let i = 0; i < 100; i++) filter.catch(new NotFoundException(), routed);
      for (let i = 0; i < 50; i++) { filter.catch(new Error('x'), routed); advance(20_000); }
      expect(alerts.notify).not.toHaveBeenCalled();
    });

    it('labels requests that matched no route without echoing the raw path', () => {
      const { filter, alerts } = filterWithClock();
      const unmatched = { switchToHttp: () => ({ getRequest: () => ({ method: 'POST', path: '/x/raw-user-value' }) }) } as unknown as ArgumentsHost;
      for (let i = 0; i <= HTTP_5XX_BURST_THRESHOLD; i++) filter.catch(new Error('x'), unmatched);
      expect((alerts.notify.mock.calls as unknown as [string, string][])[0][1]).toContain('POST (unmatched route) 500 Error');
    });
  });
});

describe('HttpExceptionFilter - request context edge cases', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('still logs one line with "-" placeholders when there is no HTTP request (exception outside a request)', () => {
    const noRequest = { switchToHttp: () => ({ getRequest: () => undefined }) } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(new Error('during bootstrap'), noRequest);
    expect(error.mock.calls.map(([line]) => line)).toEqual(['- - 500 Error: during bootstrap']);
  });

  it('caps an attacker-sized method and error name', () => {
    const host = { switchToHttp: () => ({ getRequest: () => ({ method: 'M'.repeat(100), path: '/x' }) }) } as unknown as ArgumentsHost;
    const exception = new Error('m');
    exception.name = 'N'.repeat(500);
    new HttpExceptionFilter().catch(exception, host);
    const [line] = error.mock.calls[0] as [string];
    expect(line.startsWith(`${'M'.repeat(16)}…(+84 chars) /x 500 ${'N'.repeat(100)}…(+400 chars): m`)).toBe(true);
  });

  it.each([
    [{ statusCode: 399, message: 'm' }, 500], [{ statusCode: 400, message: 'm' }, 400], [{ statusCode: 499, message: 'm' }, 499], [{ statusCode: 500, message: 'm' }, 500],
    [{ statusCode: NaN, message: 'm' }, 500], [{ statusCode: 404, status: 'x', message: 'm' }, 404], [{ status: 409, statusCode: 500, message: 'm' }, 500], [undefined, 500],
    // 응답은 message와 statusCode가 있어야 그 상태로 나간다 (Nest isHttpError) - 없으면 500
    [{ statusCode: 422 }, 500], [{ statusCode: 502, message: 'm' }, 502],
    // gaxios·undici류는 상류 응답의 status만 싣는다 - 응답은 500이므로 로그도 5xx여야 한다
    [{ status: 400, message: 'm' }, 500], [{ status: 404, message: 'm' }, 500],
  ])('statusOf(%p) → %p', (carried, status) => {
    expect(HttpExceptionFilter.statusOf(carried)).toBe(status);
  });
});

/** 실제 BaseExceptionFilter 경로 - 기본 구현이 남기던 `ExceptionsHandler` error 로그가 없어야 한다 */
describe('HttpExceptionFilter - unknown throwables (real Nest base filter)', () => {
  const reply = jest.fn();
  const adapter = { isHeadersSent: jest.fn(() => false), reply, end: jest.fn() };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ method: 'POST', path: '/auth/refresh' }) }),
    getArgByIndex: () => ({ res: true }),
  } as unknown as ArgumentsHost;
  let logged: string[];
  beforeEach(() => {
    logged = [];
    // Logger.prototype.error는 이 필터의 `HttpException` 줄이고, 기본 필터의 static Logger('ExceptionsHandler')도 같은 prototype을 쓴다
    jest.spyOn(Logger.prototype, 'error').mockImplementation(function (this: { context?: string }, ...args: unknown[]) {
      logged.push(`${this.context}: ${String(args[0])}`);
    });
    reply.mockClear();
    adapter.isHeadersSent.mockReturnValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  it('body-parser 4xx: same response as before, but no error log at all', () => {
    const malformed = Object.assign(new SyntaxError('Unexpected end of JSON input'), { status: 400, statusCode: 400, type: 'entity.parse.failed' });
    new HttpExceptionFilter(adapter as never).catch(malformed, host);
    expect(reply).toHaveBeenCalledWith({ res: true }, { statusCode: 400, message: 'Unexpected end of JSON input' }, 400);
    expect(logged).toEqual([]);
  });

  it('a 5xx logs exactly one line (this filter\'s, escaped) - the raw message never reaches ExceptionsHandler', () => {
    new HttpExceptionFilter(adapter as never).catch(new Error('invalid input syntax: "x\n[Nest] 1 - ERROR [Fake] forged"'), host);
    expect(reply).toHaveBeenCalledWith({ res: true }, { statusCode: 500, message: 'Internal server error' }, 500);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('HttpException: POST /auth/refresh 500 Error: invalid input syntax: "x\\n[Nest] 1 - ERROR [Fake] forged"');
    expect(logged.some((line) => line.includes('ExceptionsHandler') || line.includes('\n'))).toBe(false);
  });

  it.each([99, 1000, 200, 3.5])('an out-of-range carried statusCode (%p) answers 500 instead of throwing from res.status()', (statusCode) => {
    new HttpExceptionFilter(adapter as never).catch(Object.assign(new Error('odd'), { statusCode }), host);
    expect(reply).toHaveBeenCalledWith({ res: true }, { statusCode: 500, message: 'Internal server error' }, 500);
  });

  it('ends the response instead of replying when headers were already sent', () => {
    adapter.isHeadersSent.mockReturnValue(true);
    new HttpExceptionFilter(adapter as never).catch(new Error('late'), host);
    expect(reply).not.toHaveBeenCalled();
    expect(adapter.end).toHaveBeenCalledWith({ res: true });
  });
});
