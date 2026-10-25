import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertService } from '../common/alerts/alert.service';
import { DatabaseService } from '../common/database/database.service';
import { SingleFlightTask } from '../common/lifecycle/single-flight-task';
import { AWAITING_APPROVAL_PAYOUT_STATUSES, sqlStatusList } from './payout-status';

/**
 * payout 자동 송금 워커 (Phase 3)
 *
 * MVP에서는 멀티시그 송금이 수동이므로 이 워커는 상태 모니터링만 한다.
 * 자동 송금(단일 서명 핫월렛 또는 멀티시그 브로드캐스트)을 도입하면
 * APPROVED 상태 payout을 집어 BROADCASTING → PAID로 진행시키는 로직이 여기 들어간다.
 * 48시간 넘게 승인되지 않은 payout이 있으면 운영 알림(`payout-unapproved-48h`, 30분 쿨다운)을 보낸다.
 * 한 번에 하나만 돌고, 종료 시 새 실행을 막고 진행 중인 실행을 기다린다 (SingleFlightTask) — 자동 송금이 들어오면 특히 중요하다.
 */
@Injectable()
export class PayoutWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PayoutWorker.name);
  private readonly monitoring = new SingleFlightTask();

  constructor(
    private readonly db: DatabaseService,
    private readonly alerts: AlertService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitor() {
    await this.monitoring.run(() => this.monitorOnce());
  }

  /** 종료 훅 — 이 훅이 끝난 뒤에야 DB 풀이 닫힌다 (DatabaseService.onApplicationShutdown) */
  async beforeApplicationShutdown() {
    await this.monitoring.stop();
  }

  private async monitorOnce() {
    const stale = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM payout
        WHERE status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)})
          AND requested_at < now() - interval '48 hours'`,
    );
    const n = Number(stale.rows[0].count);
    if (n > 0) {
      this.logger.warn(`${n} payout(s) pending multisig approval for over 48h`);
      await this.alerts.notify('payout-unapproved-48h', `${n} payout(s) pending multisig approval for over 48h — approve or cancel them in the admin console (/admin/operations, per bounty)`);
    }
  }
}
