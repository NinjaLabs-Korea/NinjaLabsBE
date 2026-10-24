import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { HighlightsService } from './highlights.service';

@Controller('hall-of-fame')
export class HighlightsController {
  constructor(private readonly highlights: HighlightsService) {}

  /** GET /hall-of-fame — 큐레이션 하이라이트 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get()
  list() {
    return this.highlights.list();
  }

  /** GET /hall-of-fame/stats — 자동 집계 누적 지표 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get('stats')
  stats() {
    return this.highlights.stats();
  }
}
