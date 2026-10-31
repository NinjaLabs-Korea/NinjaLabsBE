import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';
import { alertBootFailure } from './common/alerts/boot-alert';
import { errorText } from './common/logging/log-safe';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 전역 파이프/필터/인터셉터/CORS/trust proxy - HTTP e2e(src/test-e2e)도 같은 함수를 쓴다
  configureApp(app);

  const port = Number(app.get(ConfigService).get<string>('PORT') ?? 4000);
  await app.listen(port);
  console.log(`NinjaLabs backend listening on :${port}`);
}

// 기동 검사 실패(MIGRATIONS_PENDING, TRUST_PROXY/JWT_SECRET 등)는 스택 대신 메시지 한 줄로 끝낸다 - 재시작 루프 로그에서 원인이 바로 보이도록.
// OPS_ALERT_WEBHOOK_URL이 있으면 exit 전에 운영 알림을 한 번 보낸다 (최대 5초, 실패하면 로그만 - common/alerts/boot-alert.ts)
bootstrap().catch(async (err: unknown) => {
  const message = errorText(err);
  console.error(`FATAL: ${message}`);
  await alertBootFailure(process.env, message);
  process.exit(1);
});
