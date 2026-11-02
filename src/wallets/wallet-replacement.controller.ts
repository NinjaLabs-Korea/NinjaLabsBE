import { Body, Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { AuthedRequest } from '../auth/authed-request';
import { MaxChars } from '../common/validation/max-chars';
import { WalletReplacementService } from './wallet-replacement.service';

export class WalletReplacementChallengeDto {
  @IsString() @IsNotEmpty() @MaxChars(255) currentAddress!: string;
  @IsString() @IsNotEmpty() @MaxChars(255) newAddress!: string;
}
export class WalletReplacementVerifyDto {
  @IsUUID() challengeId!: string;
  @IsString() @IsNotEmpty() @MaxChars(4096) currentSignature!: string;
  @IsString() @IsNotEmpty() @MaxChars(4096) newSignature!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxChars(256) currentPublicKey?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxChars(256) newPublicKey?: string;
}

@Controller('wallets/replacement')
@UseGuards(AuthGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class WalletReplacementController {
  constructor(private readonly replacement: WalletReplacementService) {}

  @Post('challenge')
  @Header('Cache-Control', 'no-store, private')
  challenge(@Req() req: AuthedRequest, @Body() dto: WalletReplacementChallengeDto) {
    return this.replacement.createChallenge(req.user.userId, dto.currentAddress, dto.newAddress);
  }

  @Post('verify')
  @Header('Cache-Control', 'no-store, private')
  verify(@Req() req: AuthedRequest, @Body() dto: WalletReplacementVerifyDto) {
    return this.replacement.verify(req.user.userId, dto);
  }
}
