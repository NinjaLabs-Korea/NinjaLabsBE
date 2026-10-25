import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { SingleFlightTask } from '../lifecycle/single-flight-task';
import { errorText } from '../logging/log-safe';

/**
 * 만료 데이터 정리 크론 — 테이블이 무한히 자라지 않게 하고, 쓸모없어진 비밀값(해시·암호화 사본)을 오래 두지 않는다.
 * 매시 정각 sweep():
 *   wallet_verification_challenge  만료 후 1일 지난 행 (verify의 "만료됨/없음" 구분에 잠깐 쓰이므로 하루 유예)
 *   auth_session                    폐기(revoked_at) 또는 만료(expires_at) 후 30일 지난 행 — 그 전까지는 감사/재사용 감지용으로 둔다
 *   oauth_login_code                만료된 행 전부 (60초 수명 — issueLoginCode도 발급 때마다 치우지만 로그인이 없으면 남는다)
 *   throttler_storage               창(expires_at)과 차단(blocked_until)이 모두 지난 rate limit 카운터 (THROTTLER_STORAGE=postgres일 때만 행이 생긴다,
 *                                   지난 행은 다음 요청이 어차피 새 창으로 덮어쓰므로 지워도 동작이 같다 — 한 번 오고 다시 안 오는 IP/토큰 해시가 쌓이지 않게)
 * 5분마다 clearGraceCopies():
 *   auth_session.grace_refresh_token  30초 재사용 유예 창이 지난 암호화 후속 토큰 사본 — 평문 해시만 둔다는 원칙의 예외라 최대 ~5분만 남게 한다
 *                                     (예전엔 매시라 최대 1시간 남았다). refresh는 창 밖 사본을 어차피 쓰지 않는다
 * 두 크론은 각자 한 번에 하나만 돌고, 종료 시 새 실행을 막고 진행 중인 실행을 기다린다 (SingleFlightTask).
 */
@Injectable()
export class MaintenanceService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly sweeps = new SingleFlightTask();
  private readonly graceClears = new SingleFlightTask();

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep() {
    await this.sweeps.run(() => this.sweepOnce());
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async clearGraceCopies() {
    await this.graceClears.run(() => this.clearGraceCopiesOnce());
  }

  /** 종료 훅 — 이 훅이 끝난 뒤에야 DB 풀이 닫힌다 (DatabaseService.onApplicationShutdown) */
  async beforeApplicationShutdown() {
    await Promise.all([this.sweeps.stop(), this.graceClears.stop()]);
  }

  /**
   * 정리 대상마다 따로 실행한다 — 한 문장이 실패(예: 쌓인 auth_session 삭제가 statement_timeout)해도 나머지 정리는 건너뛰지 않는다.
   * 하나로 묶으면 그 문장이 계속 실패하는 동안 throttler_storage·oauth_login_code 정리가 매시간 같이 죽어 테이블이 무한히 자란다.
   */
  private async sweepOnce() {
    const counts = {
      challenges: await this.deleteRows('challenges', `DELETE FROM wallet_verification_challenge WHERE expires_at < now() - interval '1 day'`),
      sessions: await this.deleteRows(
        'sessions',
        `DELETE FROM auth_session
          WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
             OR expires_at < now() - interval '30 days'`,
      ),
      login_codes: await this.deleteRows('login_codes', `DELETE FROM oauth_login_code WHERE expires_at <= now()`),
      throttles: await this.deleteRows(
        'throttles',
        `DELETE FROM throttler_storage
          WHERE expires_at <= now() AND (blocked_until IS NULL OR blocked_until <= now())`,
      ),
    };
    this.logger.log(
      `maintenance sweep: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`,
    );
  }

  /** 삭제 한 건 — 지운 행 수, 실패하면 `failed`(원인은 error 로그) */
  private async deleteRows(name: string, sql: string): Promise<number | 'failed'> {
    try {
      return (await this.db.query(sql)).rowCount ?? 0;
    } catch (err) {
      this.logger.error(`maintenance sweep ${name} failed: ${errorText(err)}`);
      return 'failed';
    }
  }

  private async clearGraceCopiesOnce() {
    try {
      const graces = await this.db.query(
        `UPDATE auth_session SET grace_refresh_token = NULL
          WHERE grace_refresh_token IS NOT NULL AND prev_rotated_at < now() - interval '30 seconds'`,
      );
      if (graces.rowCount) this.logger.log(`grace copies cleared: ${graces.rowCount}`);
    } catch (err) {
      this.logger.error(`grace copy cleanup failed: ${errorText(err)}`);
    }
  }
}
