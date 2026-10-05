import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { RewardsService } from './rewards.service';

/** 최소 단위 토큰 금액: 선행 0 없는 양의 정수 문자열 */
const TOKEN_AMOUNT = /^[1-9][0-9]{0,77}$/;

class ConfirmDepositDto {
  @IsString() @Matches(/\S/) @MaxLength(255) txHash!: string;
  @IsString() @Matches(TOKEN_AMOUNT) depositedAmount!: string;
}

class RequestPayoutDto {
  @IsUUID() rewardId!: string;
  @IsUUID() submissionId!: string;
  @IsString() @Matches(TOKEN_AMOUNT) amount!: string;
}

class MarkPaidDto {
  @IsString() @Matches(/\S/) @MaxLength(255) txHash!: string;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class RewardsAdminController {
  constructor(private readonly rewards: RewardsService) {}

  @Post('rewards/:id/confirm-deposit')
  confirmDeposit(
    @Param('id', ParseUUIDPipe) rewardId: string,
    @Req() req: AuthedRequest,
    @Body() dto: ConfirmDepositDto,
  ) {
    return this.rewards.confirmDeposit(rewardId, dto.txHash, dto.depositedAmount, req.user.userId);
  }

  @Post('payouts')
  requestPayout(@Req() req: AuthedRequest, @Body() dto: RequestPayoutDto) {
    return this.rewards.requestPayout(dto.rewardId, dto.submissionId, dto.amount, req.user.userId);
  }

  @Post('payouts/:id/approve')
  approvePayout(@Param('id', ParseUUIDPipe) payoutId: string, @Req() req: AuthedRequest) {
    return this.rewards.markApproved(payoutId, req.user.userId);
  }

  @Post('payouts/:id/paid')
  markPaid(
    @Param('id', ParseUUIDPipe) payoutId: string,
    @Req() req: AuthedRequest,
    @Body() dto: MarkPaidDto,
  ) {
    return this.rewards.markPaid(payoutId, dto.txHash, req.user.userId);
  }
}
