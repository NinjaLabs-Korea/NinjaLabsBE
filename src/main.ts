import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http/http-exception.filter';
import { RequestLoggingInterceptor } from './common/http/request-logging.interceptor';
import { trustProxyHops } from './common/bootstrap-checks';
import { OriginAllowlist } from './common/origin-allowlist';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 환경값은 ConfigModule.forRoot()가 .env를 읽은 뒤(app 생성 후) ConfigService로만 읽는다 — import 시점의 process.env는 .env 이전이다
  const config = app.get(ConfigService);

  // 리버스 프록시(Railway/Fly/LB) 뒤에서는 X-Forwarded-For를 신뢰해야 rate limit과
  // auth_session.ip_address가 클라이언트 IP로 잡힌다. 홉 수를 TRUST_PROXY로 지정한다 (기본 0 = 신뢰 안 함).
  // NODE_ENV=production에서 0/미설정이면 listen 전에 기동을 거부한다 (common/bootstrap-checks.ts).
  const trustProxy = trustProxyHops({
    TRUST_PROXY: config.get<string>('TRUST_PROXY'),
    NODE_ENV: config.get<string>('NODE_ENV'),
  });
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // SIGTERM/SIGINT 시 onModuleDestroy(pg Pool 종료)까지 실행 — 컨테이너 재배포 중 연결 누수 방지
  app.enableShutdownHooks();

  // 보안 헤더 (CSP는 API 서버라 기본값으로 충분)
  app.use(helmet());

  // CORS 허용 목록 — 정확한 오리진 또는 호스트 레이블 하나의 `*` 와일드카드 (Vercel preview). common/origin-allowlist.ts
  const corsOrigins = OriginAllowlist.fromEnv(config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000');
  app.enableCors({
    origin: (origin, callback) => callback(null, corsOrigins.allows(origin)),
    credentials: true,
  });

  // DTO 검증: 정의되지 않은 필드는 400 거절 (FE 페이로드와 DTO가 1:1로 맞춰져 있음) + 타입 자동 변환
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // 관측: 5xx 한 줄 로그(응답 포맷은 Nest 기본 유지) + 요청 로그(method path status ms, /health 제외)
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  const port = Number(config.get<string>('PORT') ?? 4000);
  await app.listen(port);
  console.log(`NinjaLabs backend listening on :${port}`);
}

// 기동 검사 실패(MIGRATIONS_PENDING, TRUST_PROXY/JWT_SECRET 등)는 스택 대신 메시지 한 줄로 끝낸다 — 재시작 루프 로그에서 원인이 바로 보이도록
bootstrap().catch((err: unknown) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
