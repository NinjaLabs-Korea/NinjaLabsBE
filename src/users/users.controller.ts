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
import { requestIdOf } from '../common/http/request-id';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { MaxChars } from '../common/validation/max-chars';
import { Trim } from '../common/validation/trim';
import { HasNoBidiOverride, HasVisibleText } from '../common/validation/visible-text';
import { AccountWithdrawalService } from './account-withdrawal.service';
import { IsNotReservedNickname, IsNotStaticFileNickname, NICKNAME, NormalizeNickname, NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from './nickname';
import { ONBOARDING_STEP } from './onboarding-step';
import { UsersService } from './users.service';

export { NICKNAME } from './nickname';

export class CompleteProfileDto {
  /** 규칙은 users/nickname.ts — 문자/숫자로 시작·끝, `_ . -` 허용, 예약어(me/check-nickname/admin/new/edit)·정적 파일 확장자(.png 등) 거부 */
  @NormalizeNickname()
  @IsString()
  @Length(NICKNAME_MIN_LENGTH, NICKNAME_MAX_LENGTH)
  @Matches(NICKNAME)
  @IsNotReservedNickname()
  @IsNotStaticFileNickname()
  nickname!: string;

  // 앞뒤 공백을 지운 뒤 비어 있지 않아야 한다 — 공백만 있는 자기소개를 필수 항목으로 받지 않는다 (FE ProfileForm도 bio.trim()으로 검사)
  @Trim()
  @IsString()
  @IsNotEmpty()
  @HasVisibleText() // 제로폭·한글 채움·점자 빈칸·소프트 하이픈만으로 된 자기소개는 빈 프로필이다
  @HasNoBidiOverride() // RLO 하나가 뒤따르는 글 순서를 뒤집는다
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
  @NormalizeNickname()
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
    const rid = requestIdOf(req);
    onboardingLog(this.logger, 'profile.save.requested', {
      rid,
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
        rid,
        traceId,
        userId: req.user.userId,
        onboardingStep: ONBOARDING_STEP.PROFILE_SAVED,
      });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'profile.save.failed', caught, {
        rid,
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
    const rid = requestIdOf(req);
    onboardingLog(this.logger, 'onboarding.complete.requested', {
      rid,
      traceId,
      userId: req.user.userId,
    });
    try {
      const result = await this.users.completeOnboarding(req.user.userId);
      onboardingLog(this.logger, 'onboarding.complete.succeeded', {
        rid,
        traceId,
        userId: req.user.userId,
      });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'onboarding.complete.failed', caught, {
        rid,
        traceId,
        userId: req.user.userId,
      });
      throw caught;
    }
  }

  /**
   * DELETE /users/me — 회원 탈퇴 (docs/decisions.md "사용자"). 200 `{ ok: true }`.
   * 400 CONFIRM_NICKNAME_MISMATCH · 409 WITHDRAWAL_BLOCKED_OPEN_PAYOUTS(종료되지 않은 payout) ·
   * 409 WITHDRAWAL_BLOCKED_PENDING_REWARDS(승인됐지만 아직 요청 안 한 지급 가능 보상) · 404 USER_NOT_FOUND(이미 탈퇴/정지).
   * refresh 세션은 전부 폐기된다 — 쿠키 모드 FE는 이어서 POST /auth/logout으로 쿠키를 지운다.
   */
  @Delete('me')
  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async withdraw(@Req() req: Request & { user: SessionUser }, @Body() dto: WithdrawAccountDto) {
    const traceId = requestTraceId(req.headers);
    const rid = requestIdOf(req);
    onboardingLog(this.logger, 'account.withdraw.requested', { rid, traceId, userId: req.user.userId });
    try {
      const result = await this.withdrawal.withdraw(req.user.userId, dto.confirmNickname);
      onboardingLog(this.logger, 'account.withdraw.succeeded', { rid, traceId, userId: req.user.userId });
      return result;
    } catch (caught) {
      onboardingError(this.logger, 'account.withdraw.failed', caught, { rid, traceId, userId: req.user.userId });
      throw caught;
    }
  }

  /** GET /users/:nickname — 공개 프로필 (커리어 페이지, 로그인 불필요) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get(':nickname')
  async publicProfile(@Param('nickname') nickname: string, @Req() req: Request) {
    // 성공 경로는 요청 로그(rid=…)로 충분하다 — 600/min 공개 읽기에 줄을 더 쓰지 않고 실패만 남긴다.
    try {
      return await this.users.publicProfile(nickname);
    } catch (caught) {
      onboardingError(this.logger, 'public-profile.failed', caught, { rid: requestIdOf(req), nickname });
      throw caught;
    }
  }
}
