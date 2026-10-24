import { describeDb } from '../test-db/describe-db';
import { saveAdminPostBody } from './support/fe-payloads';
import { E2eApp, Session, startApp } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

/** Routes owned by audit / notices / members / hall-of-fame / health, driven over HTTP through the real AppModule */
describeDb('common routes over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  let user: Session;
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
    user = await e2e.login();
  });
  afterAll(async () => e2e?.close());
  const asAdmin = () => ({ token: admin.accessToken });

  async function createNotice(title: string, publish: boolean): Promise<string> {
    const created = await e2e.post('/admin/notices', saveAdminPostBody({
      slug: '', title, bodyMarkdown: 'body', category: 'EVENT', status: publish ? 'published' : 'draft', thumbnail: null, externalUrl: null,
    }, true), asAdmin());
    expect(created.status).toBe(201);
    return created.body.id;
  }

  describe('GET /admin/audit-logs', () => {
    it('401 without a token, 403 ADMIN_ONLY for a signed-in non-admin', async () => {
      const anonymous = await e2e.get('/admin/audit-logs');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.message).toBe('MISSING_BEARER_TOKEN');
      const nonAdmin = await e2e.get('/admin/audit-logs', { token: user.accessToken });
      expect(nonAdmin.status).toBe(403);
      expect(nonAdmin.body.message).toBe('ADMIN_ONLY');
    });

    it('a demoted admin is refused on the next request even with an unexpired token (DB re-check)', async () => {
      const demoted = await e2e.loginAdmin();
      expect((await e2e.get('/admin/audit-logs', { token: demoted.accessToken })).status).toBe(200);
      await e2e.db.query('UPDATE "user" SET is_admin = false WHERE id = $1', [demoted.userId]);
      const refused = await e2e.get('/admin/audit-logs', { token: demoted.accessToken });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe('ADMIN_ONLY');
    });

    it('shows the audit trail of an admin action, filtered by entity, in the { items, page, pageSize, total } envelope', async () => {
      const id = await createNotice('Audited notice', true);
      const res = await e2e.get(`/admin/audit-logs?entityType=notice&entityId=${id}`, asAdmin());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 30, total: 1 });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ action: 'NOTICE_PUBLISHED', entity_type: 'notice', entity_id: id, actor_user_id: admin.userId });
      expect(Object.keys(res.body.items[0]).sort()).toEqual(['action', 'actor_agent_id', 'actor_user_id', 'created_at', 'entity_id', 'entity_type', 'id']);
    });

    it.each([
      ['entityId=not-a-uuid', ['entityId must be a UUID']],
      ['page=0', ['page must not be less than 1']],
      ['page=100001', ['page must not be greater than 100000']],
      [`entityType=${'x'.repeat(65)}`, ['entityType must be shorter than or equal to 64 characters']],
      ['foo=bar', ['property foo should not exist']],
    ])('?%s → 400 %p', async (query, message) => {
      expect((await e2e.get(`/admin/audit-logs?${query}`, asAdmin())).body).toEqual(badRequest(message));
    });
  });

  describe('public notices', () => {
    it('GET /notices/:id → 404 NOTICE_NOT_FOUND for an unknown id and for a draft; 200 with the body once published', async () => {
      const unknown = await e2e.get('/notices/00000000-0000-4000-8000-000000000000');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, error: 'Not Found', message: 'NOTICE_NOT_FOUND' });

      const id = await createNotice('Draft first', false);
      expect((await e2e.get(`/notices/${id}`)).status).toBe(404);
      expect((await e2e.patch(`/admin/notices/${id}`, { publish: true }, asAdmin())).status).toBe(200);
      const published = await e2e.get(`/notices/${id}`);
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ id, title: 'Draft first', body: 'body', category: 'EVENT' });
      expect(Object.keys(published.body).sort()).toEqual(['body', 'category', 'external_url', 'id', 'published_at', 'summary', 'thumbnail_url', 'title']);
    });

    it('GET /notices defaults to page 1 / pageSize 10 and filters by category', async () => {
      const res = await e2e.get('/notices');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 10 });
      expect(res.body.items.length).toBeLessThanOrEqual(10);
      const recruitment = await e2e.get('/notices?category=RECRUITMENT&pageSize=50');
      expect(recruitment.body.items.every((item: { category: string }) => item.category === 'RECRUITMENT')).toBe(true);
    });

    it('a hostile category is just an unmatched filter (bound parameter), not a 500', async () => {
      const res = await e2e.get(`/notices?category=${encodeURIComponent("EVENT' OR '1'='1")}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('lenient update URL rule over HTTP', () => {
    it('PATCH rejects an absolute URL with a backslash in the host or a space; a backslash in the path still saves', async () => {
      const id = await createNotice('URL rule', false);
      for (const url of ['https://evil.com\\.example.com/x', 'https://example.com\\@evil.com', 'https://example.com/a b.png']) {
        const res = await e2e.patch(`/admin/notices/${id}`, { externalUrl: url }, asAdmin());
        expect(res.status).toBe(400);
      }
      expect((await e2e.patch(`/admin/notices/${id}`, { externalUrl: 'https://example.com/a\\b' }, asAdmin())).status).toBe(200);
    });
  });

  it('public reads need no token: /members, /hall-of-fame, /hall-of-fame/stats', async () => {
    for (const path of ['/members', '/hall-of-fame']) {
      const res = await e2e.get(path);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
    const stats = await e2e.get('/hall-of-fame/stats');
    expect(stats.status).toBe(200);
    expect(Object.keys(stats.body).sort()).toEqual(['builders', 'completedBounties', 'completionNfts', 'paidTotals', 'sponsors']);
    const { paidTotals, ...counts } = stats.body as { paidTotals: unknown } & Record<string, unknown>;
    for (const value of Object.values(counts)) expect(Number.isInteger(value)).toBe(true);
    expect(Array.isArray(paidTotals)).toBe(true); // per-token PAID sums (shape pinned in public-reads.e2e-spec)
  });
});
