import { postOpsAlert, webhookStatus } from '../../../scripts/ops-alert';
import { logSafe } from '../logging/log-safe';

/**
 * 기동 실패(MIGRATIONS_PENDING 스키마 가드, TRUST_PROXY/JWT_SECRET 등 FATAL 검사) 알림 — main.ts의 catch가 exit 직전에 부른다.
 * Nest DI가 다 뜨기 전에 실패할 수 있으므로 AlertService가 아니라 env를 직접 읽는다 (ConfigModule.forRoot가 .env를 process.env에 이미 올렸다).
 * 웹훅이 없거나 닿지 않으면 로그만 남긴다 — 절대 throw하지 않고, 5초 타임아웃이 exit를 그 이상 붙잡지 않는다.
 * 쿨다운은 없다: 프로세스가 곧 죽으므로 in-memory 상태가 의미 없다 (재시작 루프 횟수만큼 온다 — Railway restart 정책 상한).
 */
export async function alertBootFailure(
  env: Record<string, string | undefined>,
  message: string,
  log: (line: string) => void = (line) => console.error(line),
  fetchImpl?: typeof fetch,
): Promise<void> {
  try {
    const url = env.OPS_ALERT_WEBHOOK_URL;
    if (webhookStatus(url) !== 'ok') return;
    const environment = env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'development';
    const text = `[NinjaLabs ${logSafe(environment, 40)}] boot-failure: backend refused to start — ${logSafe(message, 1000)}`;
    const result = await postOpsAlert(url!, text, { fetchImpl });
    if (!result.ok) log(`ops alert webhook unreachable for boot failure: ${result.reason}`);
  } catch {
    log('ops alert for boot failure could not be sent');
  }
}
