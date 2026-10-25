import { ArgumentsHost, Catch, HttpException, HttpServer, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { AbstractHttpAdapter } from '@nestjs/core/adapters';
import { Request } from 'express';
import { AlertService } from '../alerts/alert.service';
import { ErrorBurstDetector } from '../alerts/error-burst';
import { asHttpError } from '../database/pg-errors';
import { logSafe } from '../logging/log-safe';
import { ridSuffix } from './request-id';

/**
 * 전역 예외 필터 — 응답 포맷은 Nest 기본(BaseExceptionFilter)을 그대로 쓰고,
 * 5xx만 method/path/status/에러명/메시지를 한 줄로 남긴다.
 * 본문·헤더·쿼리스트링·토큰은 절대 기록하지 않는다 (onboarding-log 원칙과 동일).
 *
 * HttpException이 아니어도 body-parser 오류(`entity.parse.failed` 400, `entity.too.large` 413)처럼
 * 숫자 status/statusCode(4xx)를 들고 오면 그 값으로 판단한다 — Nest 기본 필터도 그 상태로 응답하므로 에러 로그가 아니다.
 *
 * 5xx 버스트 알림: 5분 안에 5xx가 20건을 넘으면 AlertService로 `http-5xx-burst` 알림 (30분 쿨다운은 AlertService가). 알림에는 건수와
 * 마지막 요청의 method·**라우트 패턴**(`/bounties/:id` — 실제 경로가 아니다)·상태·에러 이름만 싣는다. 메시지·경로 값은 사용자 값이 섞일 수 있어 뺀다.
 * 카운터는 인스턴스별 in-memory다.
 *
 * 로그는 이 필터의 한 줄(+ 스택 프레임)이 **전부**다 — Nest 기본 `BaseExceptionFilter.handleUnknownError`는 HttpException이 아닌 throwable을
 * 원본 그대로(`message` + `stack`) `ExceptionsHandler` error로 또 찍어, (1) 위 logSafe를 우회해 DB 오류 메시지가 인용한 요청 값의 CR/LF가 가짜 로그 줄이 되고
 * (2) 익명 클라이언트의 깨진 JSON 같은 4xx(body-parser)도 스택과 함께 error 레벨로 쌓였다. 아래 `handleUnknownError`가 응답은 같게 두고 그 로그만 뺀다.
 */
const MAX_STACK_FRAMES = 12;

/** 스택에서 `    at …` 프레임만 — 첫 줄(에러 메시지, 사용자 값이 섞일 수 있다)은 위 한 줄에 logSafe로 이미 있다 */
function stackFrames(caught: unknown): string | undefined {
  if (!(caught instanceof Error) || typeof caught.stack !== 'string') return undefined;
  const frames = caught.stack.split('\n').filter((line) => /^\s+at /.test(line)).slice(0, MAX_STACK_FRAMES);
  return frames.length ? `${logSafe(caught.name, 100)}\n${frames.map((line) => logSafe(line, 300)).join('\n')}` : undefined;
}
export const HTTP_5XX_BURST_THRESHOLD = 20;
export const HTTP_5XX_BURST_WINDOW_MS = 5 * 60 * 1000;

@Catch()
export class HttpExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('HttpException');
  private readonly burst: ErrorBurstDetector;

  constructor(applicationRef?: HttpServer, private readonly alerts?: AlertService, now?: () => number) {
    super(applicationRef);
    this.burst = new ErrorBurstDetector(HTTP_5XX_BURST_THRESHOLD, HTTP_5XX_BURST_WINDOW_MS, now);
  }

  /** 로그 판단용 상태 — HttpException은 getStatus(), 그 외는 4xx로 표시된 status/statusCode만 인정하고 나머지는 500 */
  static statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    const carried = exception as { status?: unknown; statusCode?: unknown } | null | undefined;
    const code = typeof carried?.status === 'number' ? carried.status
      : typeof carried?.statusCode === 'number' ? carried.statusCode : undefined;
    return code !== undefined && code >= 400 && code < 500 ? code : 500;
  }

  catch(caught: unknown, host: ArgumentsHost) {
    // 요청 값(NUL 등)을 DB가 거부한 것은 400, 풀 연결/응답 타임아웃은 503 DATABASE_UNAVAILABLE — pg-errors.ts asHttpError
    const exception = asHttpError(caught);
    const status = HttpExceptionFilter.statusOf(exception);
    if (status >= 500) {
      const req = host.switchToHttp().getRequest<Request | undefined>();
      // 503 DATABASE_UNAVAILABLE처럼 바꾼 응답이어도 로그에는 원래 원인(pg 타임아웃 메시지)을 남긴다
      const name = caught instanceof Error ? caught.name : 'UnknownError';
      const message = caught instanceof Error ? caught.message : String(caught);
      // 경로·메시지는 사용자 값이 섞일 수 있다(DB 오류 메시지는 요청 값을 인용) — CR/LF 이스케이프 + 200자 상한 (logging/log-safe.ts)
      const line = `${logSafe(req?.method ?? '-', 16)} ${logSafe(req?.path ?? req?.url ?? '-')} ${status} ${logSafe(name, 100)}: ${logSafe(message)}${ridSuffix(req)}`;
      const frames = stackFrames(caught);
      if (frames) this.logger.error(line, frames);
      else this.logger.error(line);
      if (this.alerts && this.burst.record()) {
        const route = typeof req?.route?.path === 'string' ? req.route.path : '(unmatched route)';
        void this.alerts.notify(
          'http-5xx-burst',
          `more than ${HTTP_5XX_BURST_THRESHOLD} 5xx responses in the last ${HTTP_5XX_BURST_WINDOW_MS / 60_000} min — latest: ` +
            `${logSafe(req?.method ?? '-', 16)} ${logSafe(route, 100)} ${status} ${logSafe(name, 100)}`,
        );
      }
    }
    super.catch(exception, host);
  }

  /**
   * HttpException이 아닌 throwable의 응답 — Nest 기본 구현과 같다(http-errors류 `statusCode`+`message`는 `{statusCode, message}`, 그 밖은 500 `Internal server error`).
   * 다른 점은 기본 구현의 `ExceptionsHandler` error 로그를 남기지 않는 것뿐이다 (클래스 머리말). 5xx의 로그는 `catch()`가 남긴다.
   */
  handleUnknownError(exception: unknown, host: ArgumentsHost, applicationRef: AbstractHttpAdapter | HttpServer): void {
    // 범위 밖 코드(`res.status(99)`는 RangeError)는 필터 안에서 던지지 않게 500으로 돌린다
    const body = this.isHttpError(exception) && Number.isInteger(exception.statusCode) && exception.statusCode >= 400 && exception.statusCode <= 599
      ? { statusCode: exception.statusCode, message: exception.message }
      : { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    const response = host.getArgByIndex(1);
    if (!applicationRef.isHeadersSent(response)) applicationRef.reply(response, body, body.statusCode);
    else applicationRef.end(response);
  }
}
