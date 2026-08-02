import { Controller, Get } from '@nestjs/common';
import { MembersService } from './members.service';

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** GET /members — 닌자랩스 공식 멤버 리스트 (공개) */
  @Get()
  list() {
    return this.members.list();
  }
}
