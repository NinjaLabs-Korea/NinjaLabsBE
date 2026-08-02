import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';

// JWT_SECRET 없이 프로덕션 기동 금지 — 조용한 폴백은 전체 인증 무력화로 이어진다
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret !== 'change-me-long-random-string') return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET must be set to a strong random value in production');
  }
  return 'dev-only-secret';
}

@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, AdminGuard],
  exports: [AuthService, AuthGuard, AdminGuard, JwtModule],
})
export class AuthModule {}
