import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { asHttpError } from '../database/pg-errors';
import { logSafe } from '../logging/log-safe';
import { ridSuffix } from './request-id';

/**
 * 요청 한 줄 로그 — method path status duration(ms) rid=<X-Request-Id>. `/health`(Railway 폴링)는 제외.
 * 경로만 기록하고 쿼리스트링·본문·헤더는 남기지 않는다. 가드에서 거절된 요청(401/403)은
 * 인터셉터 단계에 오지 않으므로 여기 찍히지 않는다 — 5xx는 HttpExceptionFilter가 따로 기록한다.
 *
 * 상태 코드는 핸들러 결과가 나온 시점이 아니라 응답 `finish` 이벤트에서 읽는다 — Nest는 @HttpCode/201은 인터셉터
 * 전에 쓰지만 @Redirect(302)와 핸들러가 @Res()로 직접 쓴 상태는 그 뒤에 결정되므로, 실제 전송된 상태만 남긴다.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const path = req.path ?? req.url;
    if (path === '/health') return next.handle();

    const startedAt = Date.now();
    const log = (status: number) =>
      this.logger.log(`${logSafe(req.method, 16)} ${logSafe(path)} ${status} ${Date.now() - startedAt}ms${ridSuffix(req)}`);
    return next.handle().pipe(
      tap({
        next: () => {
          if (res.writableEnded) log(res.statusCode); // @Res()로 이미 보낸 경우 finish는 지나갔다
          else res.once('finish', () => log(res.statusCode));
        },
        error: (caught: unknown) => {
          const err = asHttpError(caught); // HttpExceptionFilter와 같은 판단 - 입력 탓 DB 오류는 400, DB 연결 타임아웃은 503
          log(err instanceof HttpException ? err.getStatus() : 500);
        },
      }),
    );
  }
}
