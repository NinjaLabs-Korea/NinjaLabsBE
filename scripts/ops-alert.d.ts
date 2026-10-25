// scripts/ops-alert.js의 타입 선언 — src/common/alerts(AlertService, 기동 실패 알림)가 같은 전송 함수를 쓴다.
export declare const OPS_ALERT_TIMEOUT_MS: number;
export declare const MAX_ALERT_CHARS: number;
export declare function redactSecrets(text: string): string;
export declare function webhookStatus(url: string | undefined): 'unset' | 'invalid' | 'ok';
export declare function postOpsAlert(
  url: string,
  text: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: string }>;
/** `err.message`가 비어 있는 AggregateError(듀얼스택 연결 실패)도 원인이 남는 에러 설명 */
export declare function errorText(err: unknown): string;
