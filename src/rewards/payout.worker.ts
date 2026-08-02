import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../common/database/database.service';

/**
 * payout 자동 송금 워커 (Phase 3)
 *
 * MVP에서는 멀티시그 송금이 수동이므로 이 워커는 상태 모니터링만 한다.
 * 자동 송금(단일 서명 핫월렛 또는 멀티시그 브로드캐스트)을 도입하면
 * APPROVED 상태 payout을 집어 BROADCASTING → PAID로 진행시키는 로직이 여기 들어간다.
 */
@Injectable()
export class PayoutWorker {
  private readonly logger = new Logger(PayoutWorker.name);

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitor() {
    const stale = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM payout
        WHERE status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL')
          AND requested_at < now() - interval '48 hours'`,
    );
    const n = Number(stale.rows[0].count);
    if (n > 0) {
      this.logger.warn(`${n} payout(s) pending multisig approval for over 48h`);
      // TODO(Phase 3): 운영 알림 채널(디스코드/슬랙 웹훅) 연동
    }
  }
}
