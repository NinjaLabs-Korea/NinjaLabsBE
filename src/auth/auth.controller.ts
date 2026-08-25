import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty } from 'class-validator';
import { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';

class RefreshDto {
  @IsNotEmpty()
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** GET /auth/google — 구글 동의 화면으로 리다이렉트 */
  @Get('google')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleRedirect(@Res() res: Response) {
    const state = await this.auth.issueOauthState();
    res.redirect(this.auth.buildGoogleAuthUrl(state));
  }

  /**
   * GET /auth/google/callback — code 교환 → 세션 발급 → FE로 리다이렉트
   * 토큰은 URL fragment(#)로 전달 — fragment는 서버로 전송되지 않아 로그에 남지 않고,
   * FE 계약(refresh를 body로 보내는 방식)상 FE JS가 토큰을 직접 보관해야 한다.
   */
  @Get('google/callback')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fe = this.config.get<string>('AUTH_SUCCESS_REDIRECT') ?? 'http://localhost:3000/';
    if (error || !code || !state) {
      return res.redirect(`${fe}#error=${encodeURIComponent(error ?? 'MISSING_CODE')}`);
    }
    try {
      await this.auth.verifyOauthState(state);
      const { googleId, email } = await this.auth.exchangeGoogleCode(code);
      const user = await this.auth.upsertGoogleUser(googleId, email);
      const { accessToken, refreshToken } = await this.auth.issueSession(
        user.id,
        user.is_admin,
        req.ip,
        req.headers['user-agent'],
      );
      const params = new URLSearchParams({ accessToken, refreshToken });
      return res.redirect(`${fe}#${params}`);
    } catch {
      // 실패 사유를 FE에 상세 노출하지 않는다 (code/state 탈취 시도 힌트 방지)
      return res.redirect(`${fe}#error=AUTH_FAILED`);
    }
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

  /** GET /auth/me — 현재 세션 유저 프로필 + 온보딩/지갑/NFT 상태 */
  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: Request & { user: SessionUser }) {
    return this.auth.getMe(req.user.userId);
  }
}
