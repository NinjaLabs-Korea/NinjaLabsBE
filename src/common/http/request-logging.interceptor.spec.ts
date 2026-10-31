import {
  CallHandler, Controller, ExecutionContext, Get, HttpCode, INestApplication, Logger, NotFoundException, Post, Redirect, Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { Response } from 'express';
import { lastValueFrom, of, throwError } from 'rxjs';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

describe('RequestLoggingInterceptor', () => {
  /** Express-like response: Nest writes the final status after the interceptor chain, then the socket emits `finish`. */
  function response(statusCode = 200) {
    return Object.assign(new EventEmitter(), { statusCode, writableEnded: false });
  }
  function context(path: string, res = response(), method = 'GET') {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method, path, url: `${path}?token=secret`, headers: { authorization: 'Bearer x' } }),
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  }
  const handler = (result: unknown): CallHandler => ({ handle: () => of(result) });
  /** Simulate Nest's reply(): status written after the handler result, then the response finishes. */
  const finish = (res: ReturnType<typeof response>, statusCode: number) => {
    res.statusCode = statusCode;
    res.writableEnded = true;
    res.emit('finish');
  };

  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs method, path, status and duration without the query string', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const res = response(200);
    await expect(lastValueFrom(interceptor.intercept(context('/bounties', res), handler({ ok: true }))))
      .resolves.toEqual({ ok: true });
    finish(res, 200);
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).toMatch(/^GET \/bounties 200 \d+ms$/);
    expect(line).not.toContain('secret');
  });

  it('reads the status on the response finish event, so a status written after the handler (302 redirect) is logged', async () => {
    const res = response(200);
    await lastValueFrom(new RequestLoggingInterceptor().intercept(context('/auth/google', res), handler(undefined)));
    expect(log).not.toHaveBeenCalled(); // nothing sent yet - do not guess the status
    finish(res, 302);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^GET \/auth\/google 302 \d+ms$/));
  });

  it('logs immediately when the handler already ended the response through @Res()', async () => {
    const res = response(200);
    const manual: CallHandler = { handle: () => { finish(res, 204); return of(undefined); } };
    await lastValueFrom(new RequestLoggingInterceptor().intercept(context('/webhook', res, 'POST'), manual));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^POST \/webhook 204 \d+ms$/));
  });

  it('skips /health', async () => {
    await lastValueFrom(new RequestLoggingInterceptor().intercept(context('/health'), handler({})));
    expect(log).not.toHaveBeenCalled();
  });

  it('logs the exception status when the handler throws and re-throws it', async () => {
    const failing: CallHandler = { handle: () => throwError(() => new NotFoundException('X')) };
    await expect(lastValueFrom(new RequestLoggingInterceptor().intercept(context('/bounties/1'), failing)))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^GET \/bounties\/1 404 \d+ms$/));
  });
});

describe('RequestLoggingInterceptor through a real Nest HTTP app', () => {
  @Controller('things')
  class ThingsController {
    @Post() create() { return { id: 1 }; }
    @Post('exchange') @HttpCode(200) exchange() { return { ok: true }; }
    @Get('go') @Redirect('https://example.test/', 302) go() { return undefined; }
    @Get('missing') missing() { throw new NotFoundException('THING_NOT_FOUND'); }
    @Get('manual') manual(@Res() res: Response) { res.status(202).send('accepted'); }
  }

  let app: INestApplication;
  let baseUrl: string;
  let log: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new RequestLoggingInterceptor());
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  const lines = () => log.mock.calls.map(([line]) => line as string);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it.each([
    ['POST', '/things', 201],
    ['POST', '/things/exchange', 200],
    ['GET', '/things/go', 302],
    ['GET', '/things/missing', 404],
    ['GET', '/things/manual', 202],
  ])('%s %s logs the status actually sent (%i)', async (method, path, status) => {
    const res = await fetch(`${baseUrl}${path}?token=secret`, { method, redirect: 'manual' });
    expect(res.status).toBe(status);
    await settle();
    const matching = lines().filter((line) => line.startsWith(`${method} ${path} `));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatch(new RegExp(`^${method} ${path.replace(/\//g, '\\/')} ${status} \\d+ms$`));
    expect(matching[0]).not.toContain('secret');
  });
});

describe('RequestLoggingInterceptor - status of thrown errors, non-HTTP contexts and hostile paths', () => {
  function context(path: string, method = 'GET') {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ method, path, url: path }), getResponse: () => res }),
    } as unknown as ExecutionContext;
  }
  let log: jest.SpyInstance;
  beforeEach(() => { log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  const failWith = async (caught: unknown, path = '/x') => {
    const failing: CallHandler = { handle: () => throwError(() => caught) };
    await expect(lastValueFrom(new RequestLoggingInterceptor().intercept(context(path), failing))).rejects.toBe(caught);
    return log.mock.calls.map(([line]) => line as string);
  };

  it.each([
    ['a plain Error', new Error('boom'), 500],
    ['a thrown string', 'boom', 500],
    ['NUL rejected by Postgres (22021)', Object.assign(new Error('invalid byte sequence'), { code: '22021' }), 400],
    ['unconvertible character (22P05)', Object.assign(new Error('untranslatable character'), { code: '22P05' }), 400],
    ['FK to a missing row', Object.assign(new Error('fk'), { code: '23503', detail: 'Key (bounty_id)=(x) is not present in table "bounty".' }), 400],
    ['FK still referenced (server policy, not the client)', Object.assign(new Error('fk'), { code: '23503', detail: 'Key (id)=(x) is still referenced from table "nft".' }), 500],
    ['unique violation', Object.assign(new Error('dup'), { code: '23505' }), 500],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect'), 503],
  ])('%s → logged with status %i, original error re-thrown unchanged', async (_label, caught, status) => {
    const lines = await failWith(caught);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^GET /x ${status} \\d+ms$`));
  });

  it('passes non-HTTP contexts (cron, microservice) straight through without logging', async () => {
    const rpc = { getType: () => 'rpc', switchToHttp: () => { throw new Error('not http'); } } as unknown as ExecutionContext;
    await expect(lastValueFrom(new RequestLoggingInterceptor().intercept(rpc, { handle: () => of('done') }))).resolves.toBe('done');
    expect(log).not.toHaveBeenCalled();
  });

  it('only skips exactly /health - /healthz and /health/x are logged', async () => {
    for (const path of ['/healthz', '/health/x']) await failWith(new Error('x'), path);
    expect(log.mock.calls.map(([line]) => (line as string).split(' ')[1])).toEqual(['/healthz', '/health/x']);
  });

  it('a path carrying CR/LF cannot start a forged log line', async () => {
    const [line] = await failWith(new Error('x'), '/users/a\r\nGET /admin 200 1ms');
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toMatch(/^GET \/users\/a\\r\\nGET \/admin 200 1ms 500 \d+ms$/);
  });
});
