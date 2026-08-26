import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional } from 'class-validator';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
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
  constructor(private readonly wallets: WalletsService) {}

  /** POST /wallets/challenge — 서명용 nonce 발급 */
  @Post('challenge')
  challenge(@Req() req: Request & { user: SessionUser }, @Body() dto: ChallengeDto) {
    return this.wallets.createChallenge(req.user.userId, dto.address);
  }

  /** POST /wallets/verify — 서명 검증 후 지갑 연결 (성공 시 NFT 민팅 잡 등록) */
  @Post('verify')
  verify(@Req() req: Request & { user: SessionUser }, @Body() dto: VerifyDto) {
    return this.wallets.verifySignature(req.user.userId, dto.address, dto.signature, dto.publicKey);
  }

  /** GET /wallets/me — 내 대표 지갑 조회 */
  @Get('me')
  me(@Req() req: Request & { user: SessionUser }) {
    return this.wallets.myWallet(req.user.userId);
  }
}
