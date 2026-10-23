import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireJwtSecret } from '../common/bootstrap-checks';

/**
 * JWT_SECRET의 단일 출처 — JwtModule(서명/검증)과 AuthService(refresh 유예 사본 암호화, refresh-grace.ts)가
 * 모두 이 provider 하나를 주입받는다. 값은 ConfigModule이 .env를 읽은 **뒤** factory에서 한 번 계산되므로
 * (import 시점의 process.env가 아니라) `start:prod`가 .env의 시크릿 대신 dev 폴백으로 조용히 서명하는 일이 없다.
 * production 검사(32바이트 이상, 자리표시값 금지)는 requireJwtSecret에 있다 (common/bootstrap-checks.ts).
 */
export const JWT_SECRET = Symbol('JWT_SECRET');

export const jwtSecretProvider: Provider<string> = {
  provide: JWT_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService): string =>
    requireJwtSecret({
      JWT_SECRET: config.get<string>('JWT_SECRET'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    }),
};

@Module({ providers: [jwtSecretProvider], exports: [jwtSecretProvider] })
export class JwtSecretModule {}
