import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DatabaseService } from '../common/database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  // 한도 대상이 아니다 — production 저장소(Postgres)가 요청마다 DB를 치므로, DB 블랙홀일 때 스로틀 저장소가 연결 타임아웃(5초)을 먼저 쓰고
  // 아래 SELECT 1이 또 5초를 써서 응답이 모니터 타임아웃(runbook §6, 10초)에 걸린다 — "DB 다운"이 "앱 다운"으로 보인다. 1분 간격 모니터가 429를 받을 일도 없다
  @SkipThrottle()
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
