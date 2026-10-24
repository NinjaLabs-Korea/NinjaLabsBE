import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { postOpsAlert, webhookStatus } from '../../../scripts/ops-alert';
import { logSafe } from '../logging/log-safe';

/** 같은 키의 알림은 이 간격에 한 번만 보낸다 (인스턴스별 in-memory) */
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** 쿨다운 맵 상한 — 키는 호출부가 고정 집합으로 만들지만, 잘못 만든 키가 메모리를 키우지 못하게 한다 */
const MAX_TRACKED_KEYS = 500;
/** 알림 메시지 상한 (logSafe 기준) — 웹훅 쪽 상한(scripts/ops-alert.js MAX_ALERT_CHARS)보다 작다 */
const ALERT_MESSAGE_MAX = 1000;

/**
 * 운영 알림 — OPS_ALERT_WEBHOOK_URL(Discord/Slack 호환 incoming webhook, https)이 있으면 POST, 없으면 로그만 남긴다.
 *
 * 규칙 (docs/security.md "운영 알림", docs/decisions.md):
 *   - **절대 throw하지 않는다.** 웹훅 실패/타임아웃(5초)은 warn 로그 한 줄로 끝난다 — 알림 때문에 워커·요청이 실패하면 안 된다.
 *   - 같은 `key`는 30분에 한 번만 보낸다 (인스턴스별 in-memory). 그 사이 억제된 횟수는 다음 알림에 붙인다.
 *   - 메시지는 logSafe(제어 문자 이스케이프 + 길이 상한) 후 scripts/ops-alert.js의 redactSecrets를 거친다.
 *     호출부는 **비밀·PII(이메일, 닉네임, 요청 본문)를 넣지 않는다** — id·개수·상태·경로 패턴만.
 *   - 웹훅 URL 자체가 비밀이다 (토큰 포함) — 어떤 로그에도 찍지 않는다.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger('OpsAlert');
  private readonly webhookUrl: string | undefined;
  private readonly environment: string;
  /** key → 마지막 전송 시각 + 그 뒤 억제된 횟수 */
  private readonly cooldowns = new Map<string, { sentAt: number; suppressed: number }>();
  /** 테스트가 시계를 바꿀 수 있게 */
  private now: () => number = () => Date.now();

  constructor(config: ConfigService) {
    const url = config.get<string>('OPS_ALERT_WEBHOOK_URL');
    const status = webhookStatus(url);
    if (status === 'invalid') {
      this.logger.error('OPS_ALERT_WEBHOOK_URL is not a valid https URL — ops alerts will be logged only');
    }
    this.webhookUrl = status === 'ok' ? url!.trim() : undefined;
    this.environment = config.get<string>('RAILWAY_ENVIRONMENT_NAME') || config.get<string>('NODE_ENV') || 'development';
  }

  /** 웹훅이 설정돼 있는가 (health/진단용) */
  isConfigured(): boolean {
    return this.webhookUrl !== undefined;
  }

  /**
   * 알림 한 건. 반환값은 이번 호출이 웹훅으로 전달됐는지(테스트·진단용) — 호출부는 무시해도 된다. reject하지 않는다.
   * @param key 쿨다운 키 — 고정 문자열 또는 `<종류>:<작은 고정 집합>` (사용자 값·id를 넣지 않는다)
   * @param message 사람이 읽을 한 줄 — 비밀·PII 금지
   */
  async notify(key: string, message: string): Promise<boolean> {
    try {
      const at = this.now();
      const previous = this.cooldowns.get(key);
      if (previous && at - previous.sentAt < ALERT_COOLDOWN_MS) {
        previous.suppressed += 1;
        return false;
      }
      this.remember(key, at);
      const suppressed = previous?.suppressed ? ` (+${previous.suppressed} similar suppressed in the last ${ALERT_COOLDOWN_MS / 60_000} min)` : '';
      const line = `${logSafe(message, ALERT_MESSAGE_MAX)}${suppressed}`;
      const text = `[NinjaLabs ${logSafe(this.environment, 40)}] ${logSafe(key, 100)}: ${line}`;

      if (!this.webhookUrl) {
        this.logger.warn(`ALERT (webhook not configured) ${text}`);
        return false;
      }
      this.logger.warn(`ALERT ${text}`);
      const result = await postOpsAlert(this.webhookUrl, text);
      if (!result.ok) this.logger.warn(`ops alert webhook delivery failed for ${logSafe(key, 100)}: ${result.reason}`);
      return result.ok;
    } catch (err) {
      // postOpsAlert는 throw하지 않지만, 여기 어떤 버그도 호출부로 새지 않게 한다
      this.logger.warn(`ops alert failed for ${logSafe(key, 100)}: ${err instanceof Error ? err.name : 'Error'}`);
      return false;
    }
  }

  private remember(key: string, at: number): void {
    this.cooldowns.delete(key);
    this.cooldowns.set(key, { sentAt: at, suppressed: 0 });
    if (this.cooldowns.size <= MAX_TRACKED_KEYS) return;
    // 쿨다운이 끝난 키부터 버리고, 그래도 넘치면 가장 오래된 것(Map 삽입 순서)을 버린다
    for (const [k, v] of this.cooldowns) {
      if (at - v.sentAt >= ALERT_COOLDOWN_MS) this.cooldowns.delete(k);
    }
    while (this.cooldowns.size > MAX_TRACKED_KEYS) this.cooldowns.delete(this.cooldowns.keys().next().value!);
  }
}
