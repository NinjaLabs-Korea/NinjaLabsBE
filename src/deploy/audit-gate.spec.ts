import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKOFF_MS, MAX_ATTEMPTS, SPAWN_TIMEOUT_MS, auditWithRetry, classifyAttempt, collectAdvisories, evaluate } from '../../scripts/audit-gate';

const advisory = (severity: string, ghsa: string) => ({
  name: 'multer',
  severity,
  title: 'test advisory',
  url: `https://github.com/advisories/${ghsa}`,
  source: 1,
});
const report = (...vias: unknown[]) => ({
  vulnerabilities: {
    multer: { name: 'multer', severity: 'high', via: vias },
    '@nestjs/platform-express': { name: '@nestjs/platform-express', severity: 'high', via: ['multer'] },
  },
});
const entry = (id: string, expires = '2026-12-31') => ({ id, reason: 'on hold', expires });
const TODAY = '2026-10-25';

describe('audit-gate', () => {
  it('collects advisory objects only, ignoring string transitions and low/moderate', () => {
    const r = report(advisory('high', 'GHSA-aaaa-bbbb-cccc'), advisory('moderate', 'GHSA-dddd-eeee-ffff'));
    expect(collectAdvisories(r).map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('passes when every high advisory is allowlisted', () => {
    const res = evaluate(report(advisory('high', 'GHSA-aaaa-bbbb-cccc')), [entry('GHSA-AAAA-bbbb-cccc')], TODAY);
    expect(res.ok).toBe(true);
    expect(res.allowed).toHaveLength(1);
  });

  it('fails on an unknown high or critical advisory', () => {
    const res = evaluate(report(advisory('critical', 'GHSA-zzzz-yyyy-xxxx')), [entry('GHSA-aaaa-bbbb-cccc')], TODAY);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('GHSA-zzzz-yyyy-xxxx');
  });

  it('passes with no advisories', () => {
    expect(evaluate({ vulnerabilities: {} }, [], TODAY).ok).toBe(true);
  });

  it('fails once an allowlist entry has expired, even if the advisory is gone', () => {
    const res = evaluate({ vulnerabilities: {} }, [entry('GHSA-aaaa-bbbb-cccc', '2026-10-24')], TODAY);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('expired');
  });

  it('still allows an entry on its expiry day', () => {
    expect(evaluate({ vulnerabilities: {} }, [entry('GHSA-aaaa-bbbb-cccc', TODAY)], TODAY).ok).toBe(true);
  });

  it('rejects malformed allowlist entries', () => {
    const res = evaluate({ vulnerabilities: {} }, [{ id: 'GHSA-aaaa-bbbb-cccc', expires: 'soon' }], TODAY);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('malformed');
  });

  it('committed audit-allowlist.json is well-formed', () => {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, '../../audit-allowlist.json'), 'utf8'));
    expect(evaluate({ vulnerabilities: {} }, list, '2026-01-01').ok).toBe(true);
  });

  describe('network retry', () => {
    const okRes = { stdout: JSON.stringify({ vulnerabilities: {} }), stderr: '', status: 0 };
    const spawnErr = (code: string) => ({ error: { code }, stdout: '', stderr: '', status: null });

    it('classifies a parsed report as ok even with a non-zero exit status', () => {
      expect(classifyAttempt({ ...okRes, status: 1 }).kind).toBe('ok');
    });

    it.each(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'])('treats spawn error %s as network', (code) => {
      expect(classifyAttempt(spawnErr(code)).kind).toBe('network');
    });

    it('treats a SIGTERM kill (spawn timeout) and unparsable output as network', () => {
      expect(classifyAttempt({ signal: 'SIGTERM', stdout: '', stderr: '' }).kind).toBe('network');
      expect(classifyAttempt({ stdout: '<html>502</html>', stderr: '' }).kind).toBe('network');
    });

    it('treats an npm error report with a network code as network, otherwise fatal', () => {
      const err = (code: string, summary: string) => ({ stdout: JSON.stringify({ error: { code, summary } }), stderr: '' });
      expect(classifyAttempt(err('ENOTFOUND', 'request failed')).kind).toBe('network');
      expect(classifyAttempt(err('ENOLOCK', 'requires a lockfile')).kind).toBe('fatal');
    });

    it('treats the real npm registry-failure shape (empty code, cause only in message) as network', () => {
      const res = {
        stdout: JSON.stringify({
          message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9',
          error: { summary: '', detail: '' },
        }),
        stderr: '',
      };
      expect(classifyAttempt(res).kind).toBe('network');
    });

    it('keeps worst-case retry time under the 240s CI step timeout', () => {
      const worstMs = MAX_ATTEMPTS * SPAWN_TIMEOUT_MS + BACKOFF_MS * ((MAX_ATTEMPTS * (MAX_ATTEMPTS - 1)) / 2);
      expect(worstMs).toBeLessThan(4 * 60_000);
    });

    it('treats a non-network spawn failure as fatal', () => {
      expect(classifyAttempt(spawnErr('ENOENT')).kind).toBe('fatal');
    });

    it('retries network failures with backoff and returns the first ok result', () => {
      const run = jest.fn().mockReturnValueOnce(spawnErr('ECONNRESET')).mockReturnValueOnce(spawnErr('ETIMEDOUT')).mockReturnValue(okRes);
      const sleep = jest.fn();
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(auditWithRetry(run, sleep).kind).toBe('ok');
      expect(run).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
    });

    it('gives up as network after the max attempts without sleeping after the last one', () => {
      const run = jest.fn().mockReturnValue(spawnErr('EAI_AGAIN'));
      const sleep = jest.fn();
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(auditWithRetry(run, sleep).kind).toBe('network');
      expect(run).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not retry fatal errors', () => {
      const run = jest.fn().mockReturnValue(spawnErr('ENOENT'));
      expect(auditWithRetry(run, jest.fn()).kind).toBe('fatal');
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
