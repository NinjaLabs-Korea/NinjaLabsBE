import { ArgumentsHost, HttpException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { HttpExceptionFilter } from './http-exception.filter';

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
    new HttpExceptionFilter().catch(Object.assign(new Error('upstream'), { status: 502 }), host);
    new HttpExceptionFilter().catch(Object.assign(new Error('weird'), { status: '400' }), host);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toBe('POST /admin/bounties 500 Error: upstream');
    expect(HttpExceptionFilter.statusOf(null)).toBe(500);
  });
});
