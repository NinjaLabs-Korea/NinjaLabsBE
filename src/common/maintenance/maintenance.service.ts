import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';

/**
 * 만료 데이터 정리 크론 — 테이블이 무한히 자라지 않게 하고, 쓸모없어진 비밀값(해시·암호화 사본)을 오래 두지 않는다.
 * 매시 정각 sweep():
 *   wallet_verification_challenge  만료 후 1일 지난 행 (verify의 "만료됨/없음" 구분에 잠깐 쓰이므로 하루 유예)
 *   auth_session                    폐기(revoked_at) 또는 만료(expires_at) 후 30일 지난 행 — 그 전까지는 감사/재사용 감지용으로 둔다
 *   oauth_login_code                만료된 행 전부 (60초 수명 — issueLoginCode도 발급 때마다 치우지만 로그인이 없으면 남는다)
 * 5분마다 clearGraceCopies():
 *   auth_session.grace_refresh_token  30초 재사용 유예 창이 지난 암호화 후속 토큰 사본 — 평문 해시만 둔다는 원칙의 예외라 최대 ~5분만 남게 한다
 *                                     (예전엔 매시라 최대 1시간 남았다). refresh는 창 밖 사본을 어차피 쓰지 않는다
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  private running = false;
  private clearingGrace = false;

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const challenges = await this.db.query(
        `DELETE FROM wallet_verification_challenge WHERE expires_at < now() - interval '1 day'`,
      );
      const sessions = await this.db.query(
        `DELETE FROM auth_session
          WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
             OR expires_at < now() - interval '30 days'`,
      );
      const codes = await this.db.query(`DELETE FROM oauth_login_code WHERE expires_at <= now()`);
      this.logger.log(
        `maintenance sweep: challenges=${challenges.rowCount ?? 0} sessions=${sessions.rowCount ?? 0} login_codes=${codes.rowCount ?? 0}`,
      );
    } catch (err) {
      this.logger.error(`maintenance sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async clearGraceCopies() {
    if (this.clearingGrace) return;
    this.clearingGrace = true;
    try {
      const graces = await this.db.query(
        `UPDATE auth_session SET grace_refresh_token = NULL
          WHERE grace_refresh_token IS NOT NULL AND prev_rotated_at < now() - interval '30 seconds'`,
      );
      if (graces.rowCount) this.logger.log(`grace copies cleared: ${graces.rowCount}`);
    } catch (err) {
      this.logger.error(`grace copy cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.clearingGrace = false;
    }
  }
}
