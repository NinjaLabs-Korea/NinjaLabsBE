/**
 * 운영 알림 웹훅 전송 — Discord/Slack 호환 incoming webhook에 한 줄 메시지를 POST한다.
 *
 * NestJS 밖(scripts/migrate.js의 preDeploy 실패, main.ts의 기동 실패)과 안(src/common/alerts/alert.service.ts)이 **같은 함수**를 쓴다.
 * 이 함수는 절대 throw하지 않는다 — 알림 채널이 죽었다고 워커/요청/기동 경로가 같이 죽으면 안 된다. 결과만 돌려준다.
 *
 * 본문은 `{ content, text }` — Discord는 `content`, Slack은 `text`를 읽고 나머지 키는 무시한다 (둘 다 알 수 없는 키를 거부하지 않는다).
 * 보내기 전에 redactSecrets()로 비밀 모양 문자열을 가리고 MAX_ALERT_CHARS로 자른다 (Discord content 한도 2000자).
 */

/** 웹훅 요청 타임아웃 — 넘으면 abort하고 실패로 돌려준다 */
const OPS_ALERT_TIMEOUT_MS = 5000;
/** 알림 본문 상한 (Discord content 2000자 한도 아래) */
const MAX_ALERT_CHARS = 1800;

/**
 * 비밀처럼 보이는 것을 `[redacted]`로 — 호출자가 이미 조심하지만 마지막 방어선이다.
 *   - URL의 userinfo (`postgresql://user:pass@host` → `postgresql://[redacted]@host`)
 *   - Bearer 토큰, JWT 모양(eyJ….….…)
 *   - 64자리 hex (개인키/tx 해시 모양)
 *   - 이메일 주소 (PII)
 *   - 채널 전체 멘션(Discord `@everyone`/`@here`, Slack `<!channel>`/`<!here>`/`<!everyone>`) — 에러 문자열에 섞여 오면 채널 전원을 호출하므로 무력화
 * userinfo는 비밀번호에 `/`가 들어 있어도 가려지도록 같은 토큰 안의 마지막 `@`까지 본다 (과하게 가리는 쪽이 안전하다).
 * @param {string} text
 */
function redactSecrets(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s@]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/@(everyone|here)\b/gi, '@\u200b$1')
    .replace(/<!(channel|here|everyone)\b[^>]*>/gi, '[$1]');
}

/**
 * 웹훅 URL이 쓸 만한가 — https만 받는다 (평문 http로 운영 정보를 내보내지 않는다). 비었으면 'unset'.
 * @param {string | undefined} url
 * @returns {'unset' | 'invalid' | 'ok'}
 */
function webhookStatus(url) {
  const raw = (url || '').trim();
  if (!raw) return 'unset';
  try {
    return new URL(raw).protocol === 'https:' ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * @param {string} url 웹훅 URL (https)
 * @param {string} text 보낼 메시지 — 여기서 redact + 길이 제한한다
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function postOpsAlert(url, text, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || OPS_ALERT_TIMEOUT_MS;
  const safe = redactSecrets(text);
  const content = safe.length > MAX_ALERT_CHARS ? `${safe.slice(0, MAX_ALERT_CHARS - 1)}…` : safe;
  try {
    const res = await fetchImpl(url.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, text: content }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 응답 본문은 읽지 않는다 (소켓만 정리) — 웹훅 응답에 의존할 것이 없다
    try { await res.body?.cancel(); } catch { /* 이미 닫힘 */ }
    return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
    // 에러 메시지에 웹훅 URL(=비밀 토큰 포함)이 실릴 수 있으므로 이름만 돌려준다
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${timeoutMs}ms` : name };
  }
}

module.exports = { postOpsAlert, redactSecrets, webhookStatus, OPS_ALERT_TIMEOUT_MS, MAX_ALERT_CHARS };
