import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { postOpsAlert, webhookStatus } from '../../../scripts/ops-alert';
import { logSafe } from '../logging/log-safe';

/** 같은 키의 알림은 이 간격에 한 번만 보낸다 (인스턴스별 in-memory) — 웹훅 전달이 **성공한 시각**부터 센다 */
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** 웹훅 전달 실패 시 한 번 더 시도하기 전 대기 */
export const ALERT_RETRY_DELAY_MS = 2_000;
/** 쿨다운 맵 상한 — 키는 호출부가 고정 집합으로 만들지만, 잘못 만든 키가 메모리를 키우지 못하게 한다 */
const MAX_TRACKED_KEYS = 500;
/** 알림 메시지 상한 (logSafe 기준) — 웹훅 쪽 상한(scripts/ops-alert.js MAX_ALERT_CHARS)보다 작다 */
const ALERT_MESSAGE_MAX = 1000;

/** key별 상태 — sentAt: 마지막으로 **전달된** 시각(없으면 아직 성공한 적 없음), suppressed: 아직 보고하지 못한 같은 키 발생 수 */
type KeyState = { sentAt?: number; suppressed: number };

/**
 * 운영 알림 — OPS_ALERT_WEBHOOK_URL(Discord/Slack 호환 incoming webhook, https)이 있으면 POST, 없으면 로그만 남긴다.
 *
 * 규칙 (docs/security.md "운영 알림", docs/decisions.md):
 *   - **절대 throw하지 않는다.** 웹훅 실패/타임아웃(5초)은 warn 로그로 끝난다 — 알림 때문에 워커·요청이 실패하면 안 된다.
 *   - 같은 `key`는 30분에 한 번만 보낸다 (인스턴스별 in-memory). 쿨다운은 웹훅이 **2xx로 받은 뒤에야** 시작한다 —
 *     실패하면 2초 뒤 한 번 더 시도하고, 그래도 실패하면 쿨다운 없이 끝나 다음 발생이 다시 시도한다 (웹훅 장애가 30분짜리 침묵이 되지 않게).
 *     웹훅이 없으면(로그만) 로그를 남긴 시각부터 쿨다운.
 *   - 같은 키의 전송이 진행 중이면(재시도 대기 포함) 겹친 호출은 보내지 않고 억제 수로만 센다 (in-flight 중복 제거).
 *     억제된 횟수(쿨다운 중·진행 중·전달 실패한 발생)는 다음에 전달되는 알림에 붙인다.
 *   - 메시지는 logSafe(제어 문자 이스케이프 + 길이 상한) 후 scripts/ops-alert.js의 redactSecrets를 거친다.
 *     호출부는 **비밀·PII(이메일, 닉네임, 요청 본문)를 넣지 않는다** — id·개수·상태·경로 패턴만.
 *   - 웹훅 URL 자체가 비밀이다 (토큰 포함) — 어떤 로그에도 찍지 않는다.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger('OpsAlert');
  private readonly webhookUrl: string | undefined;
  private readonly environment: string;
  private readonly states = new Map<string, KeyState>();
  /** 전송 중인 키 (재시도 대기 포함) */
  private readonly inFlight = new Set<string>();
  /** 테스트가 시계·대기를 바꿀 수 있게 */
  private now: () => number = () => Date.now();
  private sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

  constructor(config: ConfigService) {
    const url = config.get<string>('OPS_ALERT_WEBHOOK_URL');
    const status = webhookStatus(url);
    if (status === 'invalid') {
      this.logger.error('OPS_ALERT_WEBHOOK_URL is not a valid https URL - ops alerts will be logged only');
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
   * 전달이 실패하면 재시도 때문에 약 2초 + 웹훅 타임아웃만큼 늦게 resolve한다 (호출부는 보통 `void`로 기다리지 않는다).
   * @param key 쿨다운 키 — 고정 문자열 또는 `<종류>:<작은 고정 집합>` (사용자 값·id를 넣지 않는다)
   * @param message 사람이 읽을 한 줄 — 비밀·PII 금지
   */
  async notify(key: string, message: string): Promise<boolean> {
    try {
      const at = this.now();
      const state = this.states.get(key);
      const coolingDown = state?.sentAt !== undefined && at - state.sentAt < ALERT_COOLDOWN_MS;
      if (this.inFlight.has(key) || coolingDown) {
        this.track(key).suppressed += 1;
        return false;
      }
      const reported = state?.suppressed ?? 0;
      const suppressed = reported ? ` (+${reported} similar suppressed in the last ${ALERT_COOLDOWN_MS / 60_000} min)` : '';
      const line = `${logSafe(message, ALERT_MESSAGE_MAX)}${suppressed}`;
      const text = `[NinjaLabs ${logSafe(this.environment, 40)}] ${logSafe(key, 100)}: ${line}`;

      if (!this.webhookUrl) {
        this.logger.warn(`ALERT (webhook not configured) ${text}`);
        this.markDelivered(key, at, reported);
        return false;
      }
      this.logger.warn(`ALERT ${text}`);
      this.inFlight.add(key);
      try {
        const ok = await this.deliver(this.webhookUrl, key, text);
        if (ok) this.markDelivered(key, this.now(), reported);
        else this.track(key).suppressed += 1; // 이번 발생도 보고되지 못했다 - 다음 알림의 억제 수에 넣는다
        return ok;
      } finally {
        this.inFlight.delete(key);
      }
    } catch (err) {
      // postOpsAlert는 throw하지 않지만, 여기 어떤 버그도 호출부로 새지 않게 한다
      this.logger.warn(`ops alert failed for ${logSafe(key, 100)}: ${err instanceof Error ? err.name : 'Error'}`);
      return false;
    }
  }

  /** 웹훅 POST — 실패하면 ALERT_RETRY_DELAY_MS 뒤 한 번 더. 2xx면 true */
  private async deliver(url: string, key: string, text: string): Promise<boolean> {
    const first = await postOpsAlert(url, text);
    if (first.ok) return true;
    this.logger.warn(`ops alert webhook delivery failed for ${logSafe(key, 100)}: ${first.reason} (attempt 1/2, retrying in ${ALERT_RETRY_DELAY_MS / 1000}s)`);
    await this.sleep(ALERT_RETRY_DELAY_MS);
    const second = await postOpsAlert(url, text);
    if (second.ok) return true;
    this.logger.warn(`ops alert webhook delivery failed for ${logSafe(key, 100)}: ${second.reason} (attempt 2/2, giving up - the next occurrence will try again)`);
    return false;
  }

  /** 전달 성공(또는 로그만 남긴 경우) — 쿨다운 시작. 이번 메시지에 실은 억제 수만큼 빼고, 전송 중에 쌓인 억제는 남긴다 */
  private markDelivered(key: string, at: number, reported: number): void {
    const pending = Math.max((this.states.get(key)?.suppressed ?? 0) - reported, 0);
    this.states.delete(key);
    this.states.set(key, { sentAt: at, suppressed: pending });
    this.evict(at);
  }

  private track(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { suppressed: 0 };
      this.states.set(key, state);
      this.evict(this.now());
    }
    return state;
  }

  private evict(at: number): void {
    if (this.states.size <= MAX_TRACKED_KEYS) return;
    // 쿨다운이 끝났거나 성공한 적 없는 키부터 버리고(전송 중인 키는 남김), 그래도 넘치면 가장 오래된 것(Map 삽입 순서)을 버린다
    for (const [k, v] of this.states) {
      if (this.inFlight.has(k)) continue;
      if (v.sentAt === undefined || at - v.sentAt >= ALERT_COOLDOWN_MS) this.states.delete(k);
    }
    while (this.states.size > MAX_TRACKED_KEYS) this.states.delete(this.states.keys().next().value!);
  }
}
