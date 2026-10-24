import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request } from 'express';
import { asClientError } from '../database/pg-errors';
import { logSafe } from '../logging/log-safe';

/**
 * 전역 예외 필터 — 응답 포맷은 Nest 기본(BaseExceptionFilter)을 그대로 쓰고,
 * 5xx만 method/path/status/에러명/메시지를 한 줄로 남긴다.
 * 본문·헤더·쿼리스트링·토큰은 절대 기록하지 않는다 (onboarding-log 원칙과 동일).
 *
 * HttpException이 아니어도 body-parser 오류(`entity.parse.failed` 400, `entity.too.large` 413)처럼
 * 숫자 status/statusCode(4xx)를 들고 오면 그 값으로 판단한다 — Nest 기본 필터도 그 상태로 응답하므로 에러 로그가 아니다.
 */
@Catch()
export class HttpExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('HttpException');

  /** 로그 판단용 상태 — HttpException은 getStatus(), 그 외는 4xx로 표시된 status/statusCode만 인정하고 나머지는 500 */
  static statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    const carried = exception as { status?: unknown; statusCode?: unknown } | null | undefined;
    const code = typeof carried?.status === 'number' ? carried.status
      : typeof carried?.statusCode === 'number' ? carried.statusCode : undefined;
    return code !== undefined && code >= 400 && code < 500 ? code : 500;
  }

  catch(caught: unknown, host: ArgumentsHost) {
    // 요청 값(NUL 등)을 DB가 거부한 것은 400 — pg-errors.ts asClientError
    const exception = asClientError(caught);
    const status = HttpExceptionFilter.statusOf(exception);
    if (status >= 500) {
      const req = host.switchToHttp().getRequest<Request | undefined>();
      const name = exception instanceof Error ? exception.name : 'UnknownError';
      const message = exception instanceof Error ? exception.message : String(exception);
      // 경로·메시지는 사용자 값이 섞일 수 있다(DB 오류 메시지는 요청 값을 인용) — CR/LF 이스케이프 + 200자 상한 (logging/log-safe.ts)
      this.logger.error(`${logSafe(req?.method ?? '-', 16)} ${logSafe(req?.path ?? req?.url ?? '-')} ${status} ${logSafe(name, 100)}: ${logSafe(message)}`);
    }
    super.catch(exception, host);
  }
}
