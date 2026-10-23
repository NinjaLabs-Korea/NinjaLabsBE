import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import { JWT_SECRET, JwtSecretModule } from './jwt-secret';
import { requireGoogleClientSecret } from '../common/bootstrap-checks';

/**
 * production 기동 조건 — JWT_SECRET(미설정/기본값 금지; 32바이트 미만은 기동하되 error 로그) / GOOGLE_CLIENT_SECRET 없이는 기동 거부.
 * 조용한 폴백은 전체 인증 무력화(또는 모든 로그인 실패)로 이어진다. common/bootstrap-checks.ts
 *
 * 두 검사 모두 ConfigService를 통해 **모듈 초기화 시점**에 실행된다 — import 시점의 process.env는 ConfigModule.forRoot()가
 * .env를 읽기 전이라, 그때 읽으면 로컬 `start:prod`가 .env의 시크릿 대신 dev 폴백 시크릿으로 서명할 수 있다.
 * 서명 시크릿은 JwtSecretModule의 JWT_SECRET provider 하나를 JwtModule과 AuthService가 함께 쓴다 (jwt-secret.ts).
 */
@Module({
  imports: [
    JwtSecretModule,
    JwtModule.registerAsync({
      imports: [JwtSecretModule],
      inject: [JWT_SECRET, ConfigService],
      useFactory: (secret: string, config: ConfigService) => ({
        secret,
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleIdTokenVerifier, AuthGuard, AdminGuard],
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
