import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, Matches } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { TOKEN_AMOUNT } from '../common/validation/token-amount';
import { RewardsService } from './rewards.service';
import { MaxChars } from '../common/validation/max-chars';

// txHash 형식(32바이트 hex)은 서비스가 검사해 400 INVALID_TX_HASH로 응답한다 - common/validation/tx-hash.ts
class ConfirmDepositDto {
  @IsString() @Matches(/\S/) @MaxChars(255) txHash!: string;
  @IsString() @Matches(TOKEN_AMOUNT) depositedAmount!: string;
}

class RequestPayoutDto {
  @IsUUID() rewardId!: string;
  @IsUUID() submissionId!: string;
  @IsString() @Matches(TOKEN_AMOUNT) amount!: string;
}

class MarkPaidDto {
  @IsString() @Matches(/\S/) @MaxChars(255) txHash!: string;
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
