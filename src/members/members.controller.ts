import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { MembersService } from './members.service';

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** GET /members — 닌자랩스 공식 멤버 리스트 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get()
  list() {
    return this.members.list();
  }
}
