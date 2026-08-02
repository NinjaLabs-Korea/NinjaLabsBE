import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
