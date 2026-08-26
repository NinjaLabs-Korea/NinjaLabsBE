import { Body, Controller, Get, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional } from 'class-validator';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
import {
  maskWalletAddress,
  onboardingError,
  onboardingLog,
  requestTraceId,
} from '../common/logging/onboarding-log';
import { WalletsService } from './wallets.service';

class ChallengeDto {
  @IsNotEmpty()
  address!: string;
}

class VerifyDto {
  @IsNotEmpty()
  address!: string;

  @IsNotEmpty()
  signature!: string;

  @IsOptional()
  @IsNotEmpty()
  publicKey?: string;
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(private readonly wallets: WalletsService) {}

  /** POST /wallets/challenge — 서명용 nonce 발급 */
  @Post('challenge')
  async challenge(@Req() req: Request & { user: SessionUser }, @Body() dto: ChallengeDto) {
    const traceId = requestTraceId(req.headers);
    const wallet = maskWalletAddress(dto.address);
    onboardingLog(this.logger, 'wallet.challenge.requested', {
      traceId,
      userId: req.user.userId,
      wallet,
    });
    try {
      const challenge = await this.wallets.createChallenge(req.user.userId, dto.address);
      onboardingLog(this.logger, 'wallet.challenge.created', {
        traceId,
        userId: req.user.userId,
        wallet,
        challengeId: challenge.id,
      });
      return challenge;
    } catch (caught) {
      onboardingError(this.logger, 'wallet.challenge.failed', caught, {
        traceId,
        userId: req.user.userId,
        wallet,
      });
      throw caught;
    }
  }

  /** POST /wallets/verify — 서명 검증 후 지갑 연결 (성공 시 NFT 민팅 잡 등록) */
  @Post('verify')
  async verify(@Req() req: Request & { user: SessionUser }, @Body() dto: VerifyDto) {
    const traceId = requestTraceId(req.headers);
    const wallet = maskWalletAddress(dto.address);
    onboardingLog(this.logger, 'wallet.verify.requested', {
      traceId,
      userId: req.user.userId,
      wallet,
      signatureType: dto.address.trim().startsWith('0x') ? 'EIP191' : 'ADR36',
    });
    try {
      const verified = await this.wallets.verifySignature(
        req.user.userId,
        dto.address,
        dto.signature,
        dto.publicKey,
      );
      onboardingLog(this.logger, 'wallet.verify.succeeded', {
        traceId,
        userId: req.user.userId,
        wallet,
      });
      return verified;
    } catch (caught) {
      onboardingError(this.logger, 'wallet.verify.failed', caught, {
        traceId,
        userId: req.user.userId,
        wallet,
      });
      throw caught;
    }
  }

  /** GET /wallets/me — 내 대표 지갑 조회 */
  @Get('me')
  me(@Req() req: Request & { user: SessionUser }) {
    return this.wallets.myWallet(req.user.userId);
  }
}
