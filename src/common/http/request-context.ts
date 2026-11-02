import { AsyncLocalStorage } from 'async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { isIP } from 'net';
import { Observable } from 'rxjs';

/**
 * 요청 범위 값(지금은 클라이언트 IP 하나)을 서비스 깊은 곳까지 인자 없이 전달한다. 쓰는 곳은 `AuditService`의 `audit_log.ip_address`뿐이다.
 * 컨트롤러 -> 서비스 -> 감사 호출 수십 곳에 ip 인자를 끼우지 않으려는 것이고, 요청 밖(크론·워커·운영 스크립트)에서는 값이 없다(null).
 *
 * IP는 `req.ip`만 쓴다: Express가 `trust proxy`(app-setup.ts, production 기본 1홉)로 계산한 값이라 클라이언트가 보낸
 * X-Forwarded-For를 그대로 믿지 않는다. 헤더를 직접 읽지 말 것.
 */
type RequestContext = { ip: string | null };

const storage = new AsyncLocalStorage<RequestContext>();

/** INET 컬럼에 넣어도 되는 값만 통과 - Node의 isIP는 존 ID(`fe80::1%eth0`)를 받지만 Postgres inet은 거부한다 */
export function inetOrNull(ip: string | undefined): string | null {
  return ip && isIP(ip) && !ip.includes('%') ? ip : null;
}

/** 지금 처리 중인 HTTP 요청의 클라이언트 IP (INET 리터럴) - 요청 밖이거나 IP가 리터럴이 아니면 null */
export function currentRequestIp(): string | null {
  return storage.getStore()?.ip ?? null;
}

/** 테스트와 인터셉터용 - fn과 그 비동기 후속 작업 전체에서 currentRequestIp()가 ip를 돌려준다 */
export function runWithRequestContext<T>(ip: string | undefined, fn: () => T): T {
  return storage.run({ ip: inetOrNull(ip) }, fn);
}

/**
 * 전역 인터셉터 (app-setup.ts). 미들웨어가 아니라 인터셉터인 이유: body-parser 이후에 들어가야 본문 파싱 콜백에서 컨텍스트가
 * 끊기는 문제를 피한다. 핸들러는 구독 시점에 호출되므로 구독 자체를 run 안에서 한다(next.handle()만 감싸면 컨텍스트가 비어 있다).
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    return new Observable((subscriber) => {
      const subscription = runWithRequestContext(req.ip, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
