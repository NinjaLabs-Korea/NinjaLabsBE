import { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, firstValueFrom } from 'rxjs';
import { currentRequestIp, inetOrNull, RequestContextInterceptor } from './request-context';

const httpContext = (ip: string | undefined, type = 'http') =>
  ({ getType: () => type, switchToHttp: () => ({ getRequest: () => ({ ip }) }) }) as unknown as ExecutionContext;

/** Nest처럼 구독 시점에 핸들러를 부르는 CallHandler - 핸들러 안에서 await 뒤에 IP를 읽는다 */
const handler: CallHandler = {
  handle: () => defer(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return currentRequestIp();
  }),
};

describe('RequestContextInterceptor', () => {
  it('exposes req.ip to the handler and its async continuations (the handler runs at subscribe time)', async () => {
    await expect(firstValueFrom(new RequestContextInterceptor().intercept(httpContext('198.51.100.4'), handler))).resolves.toBe('198.51.100.4');
  });

  it('keeps concurrent requests apart', async () => {
    const interceptor = new RequestContextInterceptor();
    const [a, b] = await Promise.all([
      firstValueFrom(interceptor.intercept(httpContext('198.51.100.1'), handler)),
      firstValueFrom(interceptor.intercept(httpContext('198.51.100.2'), handler)),
    ]);
    expect([a, b]).toEqual(['198.51.100.1', '198.51.100.2']);
    expect(currentRequestIp()).toBeNull();
  });

  it('stores null for a non-literal IP and skips non-HTTP contexts', async () => {
    await expect(firstValueFrom(new RequestContextInterceptor().intercept(httpContext('1.2.3.4:5678'), handler))).resolves.toBeNull();
    await expect(firstValueFrom(new RequestContextInterceptor().intercept(httpContext('198.51.100.4', 'rpc'), handler))).resolves.toBeNull();
  });
});

describe('inetOrNull', () => {
  it('passes only literals Postgres inet accepts', () => {
    expect(['10.0.0.1', '::1', 'fe80::1%eth0', '1.2.3.4:80', 'x', undefined, ''].map(inetOrNull)).toEqual(['10.0.0.1', '::1', null, null, null, null, null]);
  });
});
