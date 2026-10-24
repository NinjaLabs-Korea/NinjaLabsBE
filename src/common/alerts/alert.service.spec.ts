import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OPS_ALERT_TIMEOUT_MS, postOpsAlert } from '../../../scripts/ops-alert';
import { ALERT_COOLDOWN_MS, ALERT_RETRY_DELAY_MS, AlertService } from './alert.service';

const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-webhook-token';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('AlertService', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => jest.restoreAllMocks());

  function service(values: Record<string, string | undefined> = { OPS_ALERT_WEBHOOK_URL: WEBHOOK, NODE_ENV: 'production' }) {
    const alerts = new AlertService(config(values));
    const warn = jest.spyOn(alerts['logger'], 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(alerts['logger'], 'error').mockImplementation(() => undefined);
    let clock = 1_000_000;
    alerts['now'] = () => clock;
    const sleep = jest.fn(async (_ms: number) => undefined);
    alerts['sleep'] = sleep;
    return { alerts, warn, error, sleep, advance: (ms: number) => { clock += ms; } };
  }

  function sentBody(call = 0): { content: string; text: string } {
    return JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body));
  }

  it('posts {content, text} JSON to the webhook with a 5s abort signal', async () => {
    const { alerts } = service();
    await expect(alerts.notify('payout-unapproved-48h', '2 payout(s) pending')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = sentBody();
    expect(body.content).toBe('[NinjaLabs production] payout-unapproved-48h: 2 payout(s) pending');
    expect(body.text).toBe(body.content);
  });

  it('prefers RAILWAY_ENVIRONMENT_NAME as the environment label', async () => {
    const { alerts } = service({ OPS_ALERT_WEBHOOK_URL: WEBHOOK, NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'staging' });
    await alerts.notify('k', 'm');
    expect(sentBody().content).toBe('[NinjaLabs staging] k: m');
  });

  it('logs only (no fetch) when OPS_ALERT_WEBHOOK_URL is unset', async () => {
    const { alerts, warn } = service({ NODE_ENV: 'production' });
    expect(alerts.isConfigured()).toBe(false);
    await expect(alerts.notify('k', 'something broke')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('ALERT (webhook not configured) [NinjaLabs production] k: something broke');
  });

  it.each(['http://hooks.slack.com/services/x', 'not a url', 'ftp://example.com/x'])('rejects a non-https webhook %p at construction (logs only, URL never logged)', async (url) => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { alerts } = service({ OPS_ALERT_WEBHOOK_URL: url });
    expect(alerts.isConfigured()).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OPS_ALERT_WEBHOOK_URL is not a valid https URL'));
    expect(error.mock.calls.flat().join(' ')).not.toContain(url);
    await alerts.notify('k', 'm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the same key at most once per 30 minutes and reports how many were suppressed', async () => {
    const { alerts, advance } = service();
    await expect(alerts.notify('http-5xx-burst', 'burst')).resolves.toBe(true);
    advance(60_000);
    await expect(alerts.notify('http-5xx-burst', 'burst')).resolves.toBe(false);
    advance(ALERT_COOLDOWN_MS - 120_000);
    await expect(alerts.notify('http-5xx-burst', 'burst')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(60_000); // 30 min since the first send
    await expect(alerts.notify('http-5xx-burst', 'burst')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).content).toBe('[NinjaLabs production] http-5xx-burst: burst (+2 similar suppressed in the last 30 min)');
  });

  it('rate-limits per key — a different key is not suppressed', async () => {
    const { alerts } = service();
    await alerts.notify('a', 'x');
    await alerts.notify('b', 'x');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws: a network error, a timeout or a non-2xx is a warn log without the webhook URL (after one retry)', async () => {
    const { alerts, warn } = service();
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED ${WEBHOOK}`), { name: 'TypeError' }))
      .mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED ${WEBHOOK}`), { name: 'TypeError' }));
    await expect(alerts.notify('a', 'x')).resolves.toBe(false);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(alerts.notify('b', 'x')).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 })).mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    await expect(alerts.notify('c', 'x')).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('ops alert webhook delivery failed for a: TypeError (attempt 1/2, retrying in 2s)');
    expect(lines).toContain('ops alert webhook delivery failed for a: TypeError (attempt 2/2, giving up — the next occurrence will try again)');
    expect(lines).toContain('ops alert webhook delivery failed for b: timeout after 5000ms (attempt 2/2, giving up — the next occurrence will try again)');
    expect(lines).toContain('ops alert webhook delivery failed for c: HTTP 429 (attempt 2/2, giving up — the next occurrence will try again)');
    expect(lines.join('\n')).not.toContain('secret-webhook-token');
  });

  describe('delivery-confirmed cooldown, retry and in-flight dedupe', () => {
    it(`retries once after ${ALERT_RETRY_DELAY_MS} ms; a successful retry delivers and starts the cooldown`, async () => {
      const { alerts, sleep, advance } = service();
      fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
      await expect(alerts.notify('k', 'm')).resolves.toBe(true);
      expect(sleep).toHaveBeenCalledWith(2000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      advance(60_000);
      await expect(alerts.notify('k', 'm')).resolves.toBe(false); // cooling down
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a failed delivery (both attempts) starts no cooldown: the next occurrence tries again and reports the lost one', async () => {
      const { alerts, advance } = service();
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(new Response(null, { status: 500 }));
      await expect(alerts.notify('nft-job-failed:MINT_CHILD', '1 job failed')).resolves.toBe(false);
      advance(1_000);
      await expect(alerts.notify('nft-job-failed:MINT_CHILD', '2 jobs failed')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sentBody(2).content).toBe('[NinjaLabs production] nft-job-failed:MINT_CHILD: 2 jobs failed (+1 similar suppressed in the last 30 min)');
      advance(1_000);
      await expect(alerts.notify('nft-job-failed:MINT_CHILD', '3')).resolves.toBe(false); // now cooling down
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('the cooldown counts from the successful delivery, not from the first attempt', async () => {
      const { alerts, sleep, advance } = service();
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      sleep.mockImplementationOnce(async () => { advance(ALERT_RETRY_DELAY_MS); });
      await alerts.notify('k', 'm'); // delivered at t0 + 2 s
      advance(ALERT_COOLDOWN_MS - ALERT_RETRY_DELAY_MS); // 30 min after the first attempt, 2 s short of the cooldown
      await expect(alerts.notify('k', 'm')).resolves.toBe(false);
      advance(ALERT_RETRY_DELAY_MS);
      await expect(alerts.notify('k', 'm')).resolves.toBe(true);
    });

    it('concurrent same-key calls send once while the first is in flight (including its retry wait); others are counted as suppressed', async () => {
      const { alerts, sleep, advance } = service();
      let releaseRetry!: () => void;
      sleep.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRetry = () => resolve(undefined); }));
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 500 })) // burst, attempt 1
        .mockResolvedValueOnce(new Response(null, { status: 204 })) // other-key
        .mockResolvedValueOnce(new Response(null, { status: 500 })); // burst, attempt 2 (retry)

      const first = alerts.notify('http-5xx-burst', 'burst');
      await new Promise((resolve) => setImmediate(resolve));
      expect(sleep).toHaveBeenCalledTimes(1); // first attempt failed, waiting to retry
      const overlapping = await Promise.all([alerts.notify('http-5xx-burst', 'burst'), alerts.notify('http-5xx-burst', 'burst')]);
      expect(overlapping).toEqual([false, false]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(alerts.notify('other-key', 'x')).resolves.toBe(true); // a different key is not blocked
      expect(fetchMock).toHaveBeenCalledTimes(2);

      releaseRetry();
      await expect(first).resolves.toBe(false); // both attempts failed
      expect(fetchMock).toHaveBeenCalledTimes(3);

      advance(1);
      await expect(alerts.notify('http-5xx-burst', 'burst')).resolves.toBe(true);
      // the 2 overlapping calls + the failed delivery itself
      expect(sentBody(3).content).toBe('[NinjaLabs production] http-5xx-burst: burst (+3 similar suppressed in the last 30 min)');
    });

    it('suppressions that arrive during a successful delivery are carried to the next alert', async () => {
      const { alerts, advance } = service();
      let respond!: (r: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
      const first = alerts.notify('k', 'm');
      await new Promise((resolve) => setImmediate(resolve));
      await alerts.notify('k', 'm'); // in flight → suppressed
      respond(new Response(null, { status: 204 }));
      await expect(first).resolves.toBe(true);
      advance(ALERT_COOLDOWN_MS);
      await alerts.notify('k', 'm');
      expect(sentBody(1).content).toBe('[NinjaLabs production] k: m (+1 similar suppressed in the last 30 min)');
    });

    it('without a webhook the log line itself starts the cooldown (no log flood)', async () => {
      const { alerts, warn } = service({ NODE_ENV: 'production' });
      await alerts.notify('k', 'm');
      await alerts.notify('k', 'm');
      expect(warn.mock.calls.filter(([l]) => String(l).startsWith('ALERT'))).toHaveLength(1);
    });
  });

  it('aborts a hanging webhook after the timeout (5s by default) and reports it as a timeout', async () => {
    expect(OPS_ALERT_TIMEOUT_MS).toBe(5000);
    const hanging = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    await expect(postOpsAlert('https://example.test/hook', 'x', { fetchImpl: hanging, timeoutMs: 30 })).resolves.toEqual({ ok: false, reason: 'timeout after 30ms' });
  });

  it('escapes control characters (no forged lines) and redacts secret-shaped values and emails before sending', async () => {
    const { alerts } = service();
    await alerts.notify(
      'k',
      `boom\nFAKE LOG LINE postgresql://postgres:hunter2@db.example.co/postgres Bearer abc.def ${'a'.repeat(64)} ops@example.com eyJhbGciOi.eyJzdWIiOiIx.c2ln`,
    );
    const { content } = sentBody();
    expect(content).not.toContain('\n');
    expect(content).toContain('boom\\nFAKE LOG LINE');
    expect(content).not.toContain('hunter2');
    expect(content).toContain('postgresql://[redacted]@db.example.co/postgres');
    expect(content).toContain('Bearer [redacted]');
    expect(content).not.toContain('a'.repeat(64));
    expect(content).not.toContain('ops@example.com');
    expect(content).not.toContain('eyJzdWIiOiIx');
  });

  it('caps an oversized message', async () => {
    const { alerts } = service();
    await alerts.notify('k', 'x'.repeat(10_000));
    expect(sentBody().content.length).toBeLessThanOrEqual(1800);
  });
});
