import { readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_API_THROTTLER } from '../agents/agent-api-throttler.guard';
import { ERROR_CODES } from '../common/http/error-codes';

/**
 * 정적 가드 - `docs/agent-api.md`가 FE `/skill.md`(NinjaLabsFE `src/lib/agent-skill.ts`)의 원본이므로, 이 문서의 에러 코드 표와 rate limit 서술이
 * 실제 카탈로그·throttler 설정에서 벗어나지 않게 막는다. FE `agent-skill.test.ts`는 같은 문구를 FE 쪽에서 고정한다.
 *
 * 실제 응답 헤더는 e2e(`agents.e2e-spec`의 `x-ratelimit-remaining-agent-api`, `retry-after-agent-api`)가 확인한다.
 */
const DOC = readFileSync(join(__dirname, '..', '..', 'docs', 'agent-api.md'), 'utf8');

/** `| 401 | `CODE` | ...` 형태의 행 (코드가 백틱 하나로 감싸진 UPPER_SNAKE) */
const CODE_ROWS = [...DOC.matchAll(/^\| (\d{3}) \| `([A-Z][A-Z0-9_]+)` \|/gm)].map(([, status, code]) => ({ status: Number(status), code }));

describe('docs/agent-api.md matches the code', () => {
  it('lists error codes in its tables', () => {
    expect(CODE_ROWS.length).toBeGreaterThan(10);
  });

  it.each(CODE_ROWS)('$status $code exists in the error catalog with that status', ({ status, code }) => {
    const entry = (ERROR_CODES as Record<string, { statuses: readonly number[] }>)[code];
    expect(entry).toBeDefined();
    expect(entry.statuses).toContain(status);
  });

  it('documents the throttler headers by the real throttler name and limit', () => {
    expect(AGENT_API_THROTTLER).toMatchObject({ name: 'agent-api', ttl: 60_000, limit: 60 });
    for (const header of ['X-RateLimit-Limit-agent-api', 'X-RateLimit-Remaining-agent-api', 'X-RateLimit-Reset-agent-api', 'Retry-After-agent-api']) {
      expect(DOC).toContain(header);
    }
    expect(DOC).toContain('분당 60회');
  });

  it('does not promise an error code the API never sends for body validation', () => {
    expect(DOC).not.toContain('VALIDATION_FAILED');
    expect(DOC).toContain('Validation failed (uuid is expected)');
  });

  it('describes the real URL rule (public hosts only), not the old http(s)-only rule', () => {
    expect(DOC).toContain('IsPublicHttpUrl');
    expect(DOC).not.toContain('`IsHttpUrl`');
    expect(DOC).toContain('must be a public http(s) URL (no localhost or private addresses)');
  });
});
