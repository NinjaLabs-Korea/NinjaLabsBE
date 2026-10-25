import type { Server } from 'http';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AlertService } from './common/alerts/alert.service';
import { HttpExceptionFilter } from './common/http/http-exception.filter';
import { RequestLoggingInterceptor } from './common/http/request-logging.interceptor';
import { corsOriginsValue, requireUsableCorsOrigins, trustProxyHops } from './common/bootstrap-checks';
import { OriginAllowlist } from './common/origin-allowlist';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './common/http/request-id';

/**
 * keep-alive 유휴 한도 — Node 기본값은 5초라 Railway 엣지 프록시(자기 쪽 유휴 한도가 더 길다)가 이미 닫힌 연결에 요청을 재사용해 간헐적 502가 난다.
 * 프록시/로드밸런서의 유휴 한도(Railway·AWS ALB 모두 60초 안팎)보다 길게 둔다. headersTimeout은 keepAliveTimeout보다 커야 한다.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

/**
 * HTTP 파이프라인 설정의 단일 출처 — main.ts와 HTTP e2e 스위트(src/test-e2e)가 **같은 함수**로 앱을 구성한다.
 * 여기 없는 설정은 e2e가 검증하지 못하므로, 전역 파이프/필터/인터셉터/CORS/프록시 설정은 반드시 이 함수에 추가한다.
 */
export function configureApp(app: NestExpressApplication): void {
  // 환경값은 ConfigModule.forRoot()가 .env를 읽은 뒤(app 생성 후) ConfigService로만 읽는다 — import 시점의 process.env는 .env 이전이다
  const config = app.get(ConfigService);

  // 리버스 프록시(Railway/Fly/LB) 뒤에서는 X-Forwarded-For를 신뢰해야 rate limit과
  // auth_session.ip_address가 클라이언트 IP로 잡힌다. 홉 수를 TRUST_PROXY로 지정한다 (개발 기본 0 = 신뢰 안 함).
  // NODE_ENV=production에서 미설정이면 1로 보고 warn, 명시적 0/비정수면 listen 전에 기동을 거부한다 (common/bootstrap-checks.ts).
  const trustProxy = trustProxyHops({
    TRUST_PROXY: config.get<string>('TRUST_PROXY'),
    NODE_ENV: config.get<string>('NODE_ENV'),
  });
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  // SIGTERM/SIGINT 시 종료 훅 실행 — 크론/워커 드레인 → HTTP 종료 → pg Pool 종료(DatabaseService.onApplicationShutdown). 재배포 중 연결 누수·요청 실패 방지
  app.enableShutdownHooks();

  // 요청 ID — 요청 로그/5xx 로그를 묶는 상관 키. 가장 먼저 등록해 helmet·CORS·가드 거절 응답에도 헤더가 붙는다
  app.use(requestIdMiddleware);

  // 보안 헤더 (CSP는 API 서버라 기본값으로 충분)
  app.use(helmet());

  // CORS 허용 목록 — 정확한 오리진 또는 호스트 레이블 하나의 `*` 와일드카드 (Vercel preview). common/origin-allowlist.ts
  // production에서 미설정이면 listen 전에 기동 거부, localhost 항목은 빼고 error 로그. 개발 기본값은 로컬 FE (common/bootstrap-checks.ts)
  const corsEnv = { CORS_ORIGINS: config.get<string>('CORS_ORIGINS'), NODE_ENV: config.get<string>('NODE_ENV') };
  const corsOrigins = OriginAllowlist.fromEnv(corsOriginsValue(corsEnv));
  requireUsableCorsOrigins(corsEnv, corsOrigins.size);
  app.enableCors({
    origin: (origin, callback) => callback(null, corsOrigins.allows(origin)),
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  // DTO 검증: 정의되지 않은 필드는 400 거절 (FE 페이로드와 DTO가 1:1로 맞춰져 있음) + 타입 자동 변환
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // 관측: 5xx 한 줄 로그(응답 포맷은 Nest 기본 유지) + 5분 20건 초과 5xx 버스트 운영 알림 + 요청 로그(method path status ms, /health 제외)
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost).httpAdapter, app.get(AlertService)));
  app.useGlobalInterceptors(new RequestLoggingInterceptor());
}
