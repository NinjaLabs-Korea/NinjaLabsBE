import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectAdvisories, evaluate } from '../../scripts/audit-gate';

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
});
