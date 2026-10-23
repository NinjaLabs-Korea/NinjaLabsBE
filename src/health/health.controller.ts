import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', db: 'up' };
    } catch {
      // Railway healthcheck는 2xx만 정상으로 본다 — 같은 body 모양으로 503을 돌려준다
      throw new ServiceUnavailableException({ status: 'degraded', db: 'down' });
    }
  }
}
