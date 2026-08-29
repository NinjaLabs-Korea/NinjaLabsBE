import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { SessionUser } from '../auth/auth.service';
import { RewardsService } from '../rewards/rewards.service';
import { AdminService } from './admin.service';

class SetMemberDto {
  @IsBoolean()
  isMember!: boolean;

  @IsOptional()
  @IsIn(['CORE', 'DEV', 'DESIGN', 'OPS'])
  role?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  displayOrder?: number;
}

class CreateBountyDto {
  @IsNotEmpty() title!: string;
  @IsNotEmpty() sponsorName!: string;
  @IsNotEmpty() summary!: string;
  @IsNotEmpty() description!: string;
  @IsNotEmpty() requirements!: string;
  @IsNotEmpty() evaluationCriteria!: string;
  @IsIn(['DEV', 'DESIGN', 'CONTENT', 'OTHER']) category!: string;
  @IsBoolean() applicationRequired!: boolean;
  @IsIn(['DIRECT', 'AGENT']) submissionMode!: string;
  @Type(() => Number) @IsInt() @Min(1) maxWinners!: number;
  @IsNotEmpty() submissionDeadline!: string;
  @IsOptional() applicationDeadline?: string;
  @IsOptional() coverImageUrl?: string;
  @IsOptional() reward?: {
    tokenType: string;
    tokenDenom?: string;
    tokenContractAddress?: string;
    evmChainId?: number;
    displaySymbol: string;
    amount: string;
  };
}

class ReviewApplicationDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() note?: string;
}

class ReviewSubmissionDto {
  @IsIn(['START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT']) decision!: string;
  @IsOptional() comment?: string;
}

class CreateNoticeDto {
  @IsNotEmpty() title!: string;
  @IsOptional() summary?: string;
  @IsNotEmpty() body!: string;
  @IsIn(['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER']) category!: string;
  @IsOptional() thumbnailUrl?: string;
  @IsOptional() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class CreateHighlightDto {
  @IsIn(['MILESTONE', 'FEATURED_BOUNTY', 'PROJECT', 'PARTNERSHIP', 'AWARD', 'OTHER']) type!: string;
  @IsNotEmpty() title!: string;
  @IsNotEmpty() description!: string;
  @IsOptional() imageUrl?: string;
  @IsOptional() linkUrl?: string;
  @IsOptional() @IsUUID() bountyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() displayOrder?: number;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class UpdateBountyDto {
  @IsOptional() title?: string;
  @IsOptional() sponsorName?: string;
  @IsOptional() summary?: string;
  @IsOptional() description?: string;
  @IsOptional() requirements?: string;
  @IsOptional() evaluationCriteria?: string;
  @IsOptional() @IsIn(['DEV', 'DESIGN', 'CONTENT', 'OTHER']) category?: string;
  @IsOptional() @IsBoolean() applicationRequired?: boolean;
  @IsOptional() @IsIn(['DIRECT', 'AGENT']) submissionMode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxWinners?: number;
  @IsOptional() submissionDeadline?: string;
  @IsOptional() applicationDeadline?: string | null;
  @IsOptional() coverImageUrl?: string | null;
}

class UpdateNoticeDto {
  @IsOptional() title?: string;
  @IsOptional() summary?: string;
  @IsOptional() body?: string;
  @IsOptional() @IsIn(['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER']) category?: string;
  @IsOptional() thumbnailUrl?: string;
  @IsOptional() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class UpdateHighlightDto {
  @IsOptional() @IsIn(['MILESTONE', 'FEATURED_BOUNTY', 'PROJECT', 'PARTNERSHIP', 'AWARD', 'OTHER']) type?: string;
  @IsOptional() title?: string;
  @IsOptional() description?: string;
  @IsOptional() imageUrl?: string;
  @IsOptional() linkUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() displayOrder?: number;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class ConfirmDepositDto {
  @IsNotEmpty() txHash!: string;
  @IsNotEmpty() depositedAmount!: string;
}

class RequestPayoutDto {
  @IsUUID() rewardId!: string;
  @IsUUID() submissionId!: string;
  @IsNotEmpty() amount!: string;
}

class MarkPaidDto {
  @IsNotEmpty() txHash!: string;
}

type AuthedRequest = Request & { user: SessionUser };

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly rewards: RewardsService,
  ) {}

  // ── 유저/멤버 ──────────────────────────────────────────
  @Get('users')
  searchUsers(@Query('q') q = '') {
    return this.admin.searchUsers(q);
  }

  @Post('users/:id/member')
  setMember(
    @Param('id', ParseUUIDPipe) userId: string,
    @Req() req: AuthedRequest,
    @Body() dto: SetMemberDto,
  ) {
    return this.admin.setMember(userId, dto.isMember, dto.role, dto.displayOrder, req.user.userId);
  }

  // ── 바운티 ─────────────────────────────────────────────
  @Get('bounties')
  listBounties() {
    return this.admin.listBounties();
  }

  @Post('bounties')
  createBounty(@Req() req: AuthedRequest, @Body() dto: CreateBountyDto) {
    return this.admin.createBounty(req.user.userId, dto);
  }

  @Patch('bounties/:id')
  updateBounty(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateBountyDto,
  ) {
    return this.admin.updateBounty(bountyId, dto, req.user.userId);
  }

  @Delete('bounties/:id')
  deleteBounty(@Param('id', ParseUUIDPipe) bountyId: string, @Req() req: AuthedRequest) {
    return this.admin.deleteBounty(bountyId, req.user.userId);
  }

  @Post('bounties/:id/transition')
  transitionBounty(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AuthedRequest,
    @Body('to') to: string,
  ) {
    return this.admin.transitionBounty(bountyId, to, req.user.userId);
  }

  // ── 심사 ───────────────────────────────────────────────
  @Post('applications/:id/review')
  reviewApplication(
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Req() req: AuthedRequest,
    @Body() dto: ReviewApplicationDto,
  ) {
    return this.admin.reviewApplication(applicationId, dto.decision, dto.note, req.user.userId);
  }

  @Post('submissions/:id/review')
  reviewSubmission(
    @Param('id', ParseUUIDPipe) submissionId: string,
    @Req() req: AuthedRequest,
    @Body() dto: ReviewSubmissionDto,
  ) {
    return this.admin.reviewSubmission(submissionId, dto.decision, dto.comment, req.user.userId);
  }

  // ── 보상 ───────────────────────────────────────────────
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

  // ── 콘텐츠 ─────────────────────────────────────────────
  @Get('notices')
  listNotices() {
    return this.admin.listNotices();
  }

  @Post('notices')
  createNotice(@Req() req: AuthedRequest, @Body() dto: CreateNoticeDto) {
    return this.admin.createNotice(req.user.userId, dto);
  }

  @Patch('notices/:id')
  updateNotice(
    @Param('id', ParseUUIDPipe) noticeId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateNoticeDto,
  ) {
    return this.admin.updateNotice(noticeId, dto, req.user.userId);
  }

  @Delete('notices/:id')
  deleteNotice(@Param('id', ParseUUIDPipe) noticeId: string, @Req() req: AuthedRequest) {
    return this.admin.deleteNotice(noticeId, req.user.userId);
  }

  @Get('highlights')
  listHighlights() {
    return this.admin.listHighlights();
  }

  @Post('highlights')
  createHighlight(@Req() req: AuthedRequest, @Body() dto: CreateHighlightDto) {
    return this.admin.createHighlight(req.user.userId, dto);
  }

  @Patch('highlights/:id')
  updateHighlight(
    @Param('id', ParseUUIDPipe) highlightId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateHighlightDto,
  ) {
    return this.admin.updateHighlight(highlightId, dto, req.user.userId);
  }

  @Delete('highlights/:id')
  deleteHighlight(@Param('id', ParseUUIDPipe) highlightId: string, @Req() req: AuthedRequest) {
    return this.admin.deleteHighlight(highlightId, req.user.userId);
  }
}
