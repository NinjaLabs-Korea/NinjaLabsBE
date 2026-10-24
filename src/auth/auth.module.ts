import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_TOKEN_THROTTLER, AuthTokenThrottlerGuard } from './auth-throttler.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { JWT_SECRET, JwtSecretModule } from './jwt-secret';
import { TurnstileVerifier } from './turnstile.verifier';
import { accessTtlSeconds } from './refresh-ttl';
import { requireGoogleClientSecret } from '../common/bootstrap-checks';
import { throttlerModule } from '../common/throttler/throttler-options';

/**
 * production 기동 조건 — JWT_SECRET(미설정/기본값 금지; 32바이트 미만은 기동하되 error 로그) / GOOGLE_CLIENT_SECRET 없이는 기동 거부.
 * 조용한 폴백은 전체 인증 무력화(또는 모든 로그인 실패)로 이어진다. common/bootstrap-checks.ts
 *
 * 두 검사 모두 ConfigService를 통해 **모듈 초기화 시점**에 실행된다 — import 시점의 process.env는 ConfigModule.forRoot()가
 * .env를 읽기 전이라, 그때 읽으면 로컬 `start:prod`가 .env의 시크릿 대신 dev 폴백 시크릿으로 서명할 수 있다.
 * JWT_ACCESS_TTL은 JwtModule 팩토리에서 검증한다 — 단위 없는 값/60초~60분 밖이면 환경과 무관하게 부팅 실패 (JWT_REFRESH_TTL과 같은 규칙, refresh-ttl.ts).
 * TURNSTILE_SECRET_KEY는 선택 — 미설정이면 production에서 기동 시 warn만 한다 (turnstile.verifier.ts).
 * 서명 시크릿은 JwtSecretModule의 JWT_SECRET provider 하나를 JwtModule과 AuthService가 함께 쓴다 (jwt-secret.ts).
 */
@Module({
  imports: [
    JwtSecretModule,
    // /auth/exchange·/auth/refresh·/auth/logout의 자격 증명(코드/refresh 토큰) 해시별 한도 — 전역 IP 한도(app.module.ts)와 독립된 저장소 (auth-throttler.guard.ts)
    // 저장소는 THROTTLER_STORAGE를 따른다 (production 기본 postgres — 레플리카 간 공유, common/throttler/throttler-options.ts)
    throttlerModule([AUTH_TOKEN_THROTTLER]),
    JwtModule.registerAsync({
      imports: [JwtSecretModule],
      inject: [JWT_SECRET, ConfigService],
      useFactory: (secret: string, config: ConfigService) => ({
        secret,
        // 초 단위 숫자로 넘긴다 — 문자열 `900`은 jsonwebtoken이 밀리초로 읽어 발급 즉시 만료된다. 형식/범위(60초~60분)가 틀리면 부팅 실패 (refresh-ttl.ts)
        signOptions: { expiresIn: accessTtlSeconds(config.get<string>('JWT_ACCESS_TTL')) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleIdTokenVerifier, TurnstileVerifier, AuthGuard, AdminGuard, AuthTokenThrottlerGuard],
  exports: [AuthService, AuthGuard, AdminGuard, JwtModule],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    requireGoogleClientSecret({
      NODE_ENV: this.config.get<string>('NODE_ENV'),
      GOOGLE_CLIENT_SECRET: this.config.get<string>('GOOGLE_CLIENT_SECRET'),
    });
  }
}
