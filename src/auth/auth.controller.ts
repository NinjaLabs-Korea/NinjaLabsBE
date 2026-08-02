import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotImplementedException,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty } from 'class-validator';
import { Request } from 'express';
import { AuthService } from './auth.service';

class RefreshDto {
  @IsNotEmpty()
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * GET /auth/google — 구글 동의 화면으로 리다이렉트
   * TODO(구현): GOOGLE_CLIENT_ID로 authorization URL 조립 후 302
   */
  @Get('google')
  googleRedirect() {
    throw new NotImplementedException('TODO: redirect to Google OAuth consent screen');
  }

  /**
   * GET /auth/google/callback — code 교환 → 세션 발급 → FE로 리다이렉트
   * TODO(구현): code→token 교환, upsertGoogleUser, issueSession,
   *             AUTH_SUCCESS_REDIRECT로 리다이렉트 (httpOnly 쿠키 or 쿼리 전달은 FE와 합의)
   */
  @Get('google/callback')
  googleCallback() {
    throw new NotImplementedException('TODO: exchange code, issue session');
  }

  /** POST /auth/refresh — 토큰 재발급 (refresh token 회전: 응답의 새 refreshToken으로 교체 필수) */
  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // 무차별 대입 방어
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, req.ip, req.headers['user-agent']);
  }

  /** POST /auth/logout — refresh 세션 폐기 */
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.revoke(dto.refreshToken);
  }

  /** GET /auth/me — 현재 세션 유저 (AuthGuard 적용 예시는 users 모듈 참고) */
  @Get('me')
  me(@Req() _req: Request) {
    throw new NotImplementedException('TODO: return current session user profile');
  }
}
