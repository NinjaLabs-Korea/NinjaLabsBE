import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';
/** 들어오는 X-Request-Id 허용 형식 — 로그 줄/응답 헤더에 그대로 쓰이므로 공백·CR/LF·구분자를 허용하지 않는다 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

type WithRequestId = Request & { requestId?: string };

/** 유효한 들어온 ID는 유지하고, 없거나 형식이 틀리면(중복 헤더 포함) 새 UUID를 만든다 */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
}

/** 요청에 ID를 붙이고 응답 헤더로 돌려준다. configureApp()에서 가장 먼저 등록한다 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers['x-request-id']);
  (req as WithRequestId).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** 로그 줄 접미사 — 미들웨어를 거치지 않은 요청(단위 테스트 등)에는 빈 문자열 */
export function ridSuffix(req: Request | undefined): string {
  const id = (req as WithRequestId | undefined)?.requestId;
  return id ? ` rid=${id}` : '';
}
