import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../auth/admin.guard';
import { AuthedRequest } from '../../auth/authed-request';
import { CreateBountyDto, UpdateBountyDto } from './bounty-admin.dto';
import { BountyAdminService } from './bounty-admin.service';

@Controller('admin/bounties')
@UseGuards(AdminGuard)
export class BountyAdminController {
  constructor(private readonly bounties: BountyAdminService) {}

  @Get()
  list() {
    return this.bounties.list();
  }

  @Get(':id/operations')
  operations(@Param('id', ParseUUIDPipe) bountyId: string) {
    return this.bounties.operations(bountyId);
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateBountyDto) {
    return this.bounties.create(req.user.userId, dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateBountyDto,
  ) {
    return this.bounties.update(bountyId, dto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) bountyId: string, @Req() req: AuthedRequest) {
    return this.bounties.remove(bountyId, req.user.userId);
  }

  @Post(':id/transition')
  transition(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AuthedRequest,
    @Body('to') to: string,
  ) {
    return this.bounties.transition(bountyId, to, req.user.userId);
  }
}
