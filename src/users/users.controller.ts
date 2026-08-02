import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, Length } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
import { UsersService } from './users.service';

class CompleteProfileDto {
  @Length(2, 50)
  nickname!: string;

  @IsNotEmpty()
  bio!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['DEV', 'DESIGN', 'CONTENT', 'OTHER'], { each: true })
  tags!: string[];
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /users/check-nickname?nickname=... — 닉네임 중복 검사 (공개) */
  @Get('check-nickname')
  @Throttle({ default: { ttl: 60_000, limit: 30 } }) // 닉네임 열거 방지
  async checkNickname(@Query('nickname') nickname: string) {
    return { available: await this.users.nicknameAvailable(nickname ?? '') };
  }

  /** POST /users/me/profile — 온보딩 3단계 프로필 저장 (로그인 필요) */
  @Post('me/profile')
  @UseGuards(AuthGuard)
  completeProfile(
    @Req() req: Request & { user: SessionUser },
    @Body() dto: CompleteProfileDto,
  ) {
    return this.users.completeProfile(req.user.userId, dto.nickname, dto.bio, dto.tags);
  }

  /** POST /users/me/complete-onboarding — 온보딩 완료 처리 */
  @Post('me/complete-onboarding')
  @UseGuards(AuthGuard)
  completeOnboarding(@Req() req: Request & { user: SessionUser }) {
    return this.users.completeOnboarding(req.user.userId);
  }

  /** GET /users/:nickname — 공개 프로필 (커리어 페이지, 로그인 불필요) */
  @Get(':nickname')
  publicProfile(@Param('nickname') nickname: string) {
    return this.users.publicProfile(nickname);
  }
}
