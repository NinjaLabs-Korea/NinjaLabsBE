import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
import {
  onboardingError,
  onboardingLog,
  requestTraceId,
} from '../common/logging/onboarding-log';
import { MaxChars } from '../common/validation/max-chars';
import { Trim } from '../common/validation/trim';
import { AccountWithdrawalService } from './account-withdrawal.service';
import { IsNotReservedNickname, IsNotStaticFileNickname, NICKNAME, NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from './nickname';
import { UsersService } from './users.service';

export { NICKNAME } from './nickname';

export class CompleteProfileDto {
  /** 규칙은 users/nickname.ts — 문자/숫자로 시작·끝, `_ . -` 허용, 예약어(me/check-nickname/admin/new/edit)·정적 파일 확장자(.png 등) 거부 */
  @Trim()
  @IsString()
  @Length(NICKNAME_MIN_LENGTH, NICKNAME_MAX_LENGTH)
  @Matches(NICKNAME)
  @IsNotReservedNickname()
  @IsNotStaticFileNickname()
  nickname!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  bio!: string;

  /** 집합으로 정규화한다 — `['DEV','DEV']`가 user_tag PK 충돌(23505)로 NICKNAME_TAKEN 409가 되던 것. FE(ProfileForm)는 토글이라 중복을 보내지 않는다 */
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? [...new Set(value)] : value))
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['DEV', 'DESIGN', 'CONTENT', 'OTHER'], { each: true })
  tags!: string[];
}

/** DELETE /users/me 본문 — 지금 닉네임을 그대로 다시 입력해 확인한다 (비교는 앞뒤 공백·대소문자 무시) */
export class WithdrawAccountDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxChars(NICKNAME_MAX_LENGTH)
  confirmNickname!: string;
}

@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly users: UsersService,
    private readonly withdrawal: AccountWithdrawalService,
  ) {}

  /** GET /users/check-nickname?nickname=... — 닉네임 중복 검사 (공개) */
  @Get('check-nickname')
  @Throttle({ default: { ttl: 60_000, limit: 30 } }) // 닉네임 열거 방지
  async checkNickname(@Query('nickname') nickname: unknown) {
    // 반복 파라미터(`?nickname=a&nickname=b`)는 배열로 온다 — 서비스가 문자열이 아니면 사용 불가로 답한다
    return { available: await this.users.nicknameAvailable(nickname) };
  }

  /** POST /users/me/profile — 온보딩 3단계 프로필 저장 (로그인 필요) */
  @Post('me/profile')
  @UseGuards(AuthGuard)
  async completeProfile(
    @Req() req: Request & { user: SessionUser },
    @Body() dto: CompleteProfileDto,
  ) {
    const traceId = requestTraceId(req.headers);
    onboardingLog(this.logger, 'profile.save.requested', {
      traceId,
      userId: req.user.userId,
      nicknameLength: dto.nickname.length,
      bioLength: dto.bio.length,
      tagCount: dto.tags.length,
    });
    try {
      const result = await this.users.completeProfile(
        req.user.userId,
        dto.nickname,
        dto.bio,
        dto.tags,
      );
      onboardingLog(this.logger, 'profile.save.succeeded', {
        traceId,
        userId: req.user.userId,
        onboardingStep: 4,
      });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'profile.save.failed', caught, {
        traceId,
        userId: req.user.userId,
      });
      throw caught;
    }
  }

  /** POST /users/me/complete-onboarding — 온보딩 완료 처리 */
  @Post('me/complete-onboarding')
  @UseGuards(AuthGuard)
  async completeOnboarding(@Req() req: Request & { user: SessionUser }) {
    const traceId = requestTraceId(req.headers);
    onboardingLog(this.logger, 'onboarding.complete.requested', {
      traceId,
      userId: req.user.userId,
    });
    try {
      const result = await this.users.completeOnboarding(req.user.userId);
      onboardingLog(this.logger, 'onboarding.complete.succeeded', {
        traceId,
        userId: req.user.userId,
      });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'onboarding.complete.failed', caught, {
        traceId,
        userId: req.user.userId,
      });
      throw caught;
    }
  }

  /**
   * DELETE /users/me — 회원 탈퇴 (docs/decisions.md "사용자"). 200 `{ ok: true }`.
   * 400 CONFIRM_NICKNAME_MISMATCH · 409 WITHDRAWAL_BLOCKED_OPEN_PAYOUTS(종료되지 않은 payout) · 404 USER_NOT_FOUND(이미 탈퇴/정지).
   * refresh 세션은 전부 폐기된다 — 쿠키 모드 FE는 이어서 POST /auth/logout으로 쿠키를 지운다.
   */
  @Delete('me')
  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async withdraw(@Req() req: Request & { user: SessionUser }, @Body() dto: WithdrawAccountDto) {
    const traceId = requestTraceId(req.headers);
    onboardingLog(this.logger, 'account.withdraw.requested', { traceId, userId: req.user.userId });
    try {
      const result = await this.withdrawal.withdraw(req.user.userId, dto.confirmNickname);
      onboardingLog(this.logger, 'account.withdraw.succeeded', { traceId, userId: req.user.userId });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'account.withdraw.failed', caught, { traceId, userId: req.user.userId });
      throw caught;
    }
  }

  /** GET /users/:nickname — 공개 프로필 (커리어 페이지, 로그인 불필요) */
  @Get(':nickname')
  async publicProfile(@Param('nickname') nickname: string) {
    onboardingLog(this.logger, 'public-profile.requested', { nickname });
    try {
      const profile = await this.users.publicProfile(nickname);
      onboardingLog(this.logger, 'public-profile.succeeded', {
        nickname,
        found: true,
      });
      return profile;
    } catch (caught) {
      onboardingError(this.logger, 'public-profile.failed', caught, { nickname });
      throw caught;
    }
  }
}
