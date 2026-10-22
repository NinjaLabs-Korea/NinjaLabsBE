import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 리버스 프록시(Railway/Fly/LB) 뒤에서는 X-Forwarded-For를 신뢰해야 rate limit과
  // auth_session.ip_address가 클라이언트 IP로 잡힌다. 홉 수를 TRUST_PROXY로 지정한다 (기본 0 = 신뢰 안 함).
  const trustProxy = Number(process.env.TRUST_PROXY ?? 0);
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // SIGTERM/SIGINT 시 onModuleDestroy(pg Pool 종료)까지 실행 — 컨테이너 재배포 중 연결 누수 방지
  app.enableShutdownHooks();

  // 보안 헤더 (CSP는 API 서버라 기본값으로 충분)
  app.use(helmet());

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });

  // DTO 검증: 정의되지 않은 필드 제거 + 타입 자동 변환
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`NinjaLabs backend listening on :${port}`);
}

void bootstrap();
