import { Global, Module } from '@nestjs/common';
import { AlertService } from './alert.service';

/** 운영 알림 - 전역 모듈 (워커·예외 필터 어디서나 주입). OPS_ALERT_WEBHOOK_URL 없으면 로그만 남긴다 */
@Global()
@Module({
  providers: [AlertService],
  exports: [AlertService],
})
export class AlertsModule {}
