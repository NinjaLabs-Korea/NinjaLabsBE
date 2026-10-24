import { describeDb } from '../test-db/describe-db';
import { AdminBountyForm, applyBody, saveAdminBountyBody, saveAdminHighlightBody, saveAdminPostBody, setAdminMemberBody, submitBody } from './support/fe-payloads';
import { DAY, E2eApp, isoIn, multipart, PNG_1x1, Session, startApp, UUID } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

function bountyForm(overrides: Partial<AdminBountyForm> = {}): AdminBountyForm {
  return {
    slug: '', title: 'Validation bounty', sponsor: 'Sponsor', description: 'Long description',
    requirements: 'reqs', reviewProcess: 'review', tags: ['Design'], intakeEnabled: false, maxWinners: 1,
    submissionMode: 'direct', coverImage: null, deadline: isoIn(10 * DAY), reward: { amount: 5, currency: 'INJ' }, ...overrides,
  };
}

// e. validation — global ValidationPipe {whitelist, forbidNonWhitelisted, transform} against the bodies the FE really sends
describeDb('validation over HTTP (e2e)', () => {
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

  async function openBounty(form: AdminBountyForm = bountyForm({ reward: { amount: 0, currency: 'INJ' } })): Promise<string> {
    const created = await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), asAdmin());
    expect(created.status).toBe(201);
    expect((await e2e.post(`/admin/bounties/${created.body.id}/transition`, { to: 'OPEN' }, asAdmin())).status).toBe(201);
    return created.body.id;
  }

  describe('FE-shaped payloads pass on every write route', () => {
    it('admin bounty: create with nested reward and a /media cover, update clearing the cover with null', async () => {
      const upload = multipart([{ name: 'file', value: PNG_1x1, filename: 'cover.png', contentType: 'image/png' }]);
      const media = await e2e.request('POST', '/admin/media', { body: upload.body, headers: { 'content-type': upload.contentType }, token: admin.accessToken });
      expect(media.status).toBe(201);
      const form = bountyForm({ coverImage: media.body.url, intakeEnabled: true, submissionMode: 'agent' });
      const created = await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), asAdmin());
      expect(created.status).toBe(201);
      const id = created.body.id;
      let row = (await e2e.get('/admin/bounties', asAdmin())).body.find((r: { id: string }) => r.id === id);
      expect(row).toMatchObject({ cover_image_url: media.body.url, category: 'DESIGN', submission_mode: 'AGENT', application_required: true, status: 'FUNDING_PENDING' });

      const cleared = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody({ ...form, slug: id, coverImage: null, deadline: row.submission_deadline }, false), asAdmin());
      expect(cleared.status).toBe(200);
      row = (await e2e.get('/admin/bounties', asAdmin())).body.find((r: { id: string }) => r.id === id);
      expect(row.cover_image_url).toBeNull();
      // the update body carries no `reward` (FE sends it only on create)
      expect(saveAdminBountyBody(form, false)).not.toHaveProperty('reward');
    });

    it('notices: create (published) with thumbnail/external URL, update clearing both with null, toggling publish', async () => {
      const post = { slug: '', title: 'Launch', bodyMarkdown: '# Hello\n'.repeat(50), category: 'EVENT', status: 'published' as const, thumbnail: '/media/00000000-0000-4000-8000-000000000000', externalUrl: 'https://ninjalabs.xyz/launch' };
      const created = await e2e.post('/admin/notices', saveAdminPostBody(post, true), asAdmin());
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ id: expect.stringMatching(UUID) });
      const id = created.body.id;
      const updated = await e2e.patch(`/admin/notices/${id}`, saveAdminPostBody({ ...post, slug: id, thumbnail: null, externalUrl: null }, false), asAdmin());
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ id, status: 'PUBLISHED' });
      const row = (await e2e.get('/admin/notices', asAdmin())).body.find((r: { id: string }) => r.id === id);
      expect(row).toMatchObject({ thumbnail_url: null, external_url: null, status: 'PUBLISHED' });
      const draft = await e2e.patch(`/admin/notices/${id}`, saveAdminPostBody({ ...post, slug: id }, false, { publish: false }), asAdmin());
      expect(draft.body).toEqual({ id, status: 'DRAFT' });
    });

    it('highlights: create with null image and a site-path link, update with typeChanged', async () => {
      const item = { id: '', type: 'MILESTONE', title: '100 builders', order: 1, link: '/bounties/abc', image: null, published: true };
      const created = await e2e.post('/admin/highlights', saveAdminHighlightBody(item, true), asAdmin());
      expect(created.status).toBe(201);
      const id = created.body.id;
      const updated = await e2e.patch(`/admin/highlights/${id}`, saveAdminHighlightBody({ ...item, id, type: 'AWARD', image: 'https://cdn.example/a.png' }, false, { typeChanged: true }), asAdmin());
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ id, is_published: true });
      const unpublished = await e2e.patch(`/admin/highlights/${id}`, saveAdminHighlightBody({ ...item, id }, false, { publish: false }), asAdmin());
      expect(unpublished.body).toEqual({ id, is_published: false });
    });

    it('member set: grant with role label → code + displayOrder, revoke with only isMember', async () => {
      const granted = await e2e.post(`/admin/users/${user.userId}/member`, setAdminMemberBody({ isMember: true, role: 'Core', displayOrder: 2 }), asAdmin());
      expect(granted.status).toBe(201);
      expect(granted.body).toMatchObject({ id: user.userId, is_member: true, member_role: 'CORE' });
      const revoked = await e2e.post(`/admin/users/${user.userId}/member`, setAdminMemberBody({ isMember: false }), asAdmin());
      expect(revoked.body).toMatchObject({ is_member: false, member_role: null });
      const search = await e2e.get(`/admin/users?q=${encodeURIComponent(user.email)}`, asAdmin());
      expect(search.body).toEqual([expect.objectContaining({ id: user.userId, email: user.email, is_member: false, member_role: null, member_display_order: null, wallet_address: null })]);
    });

    it('applications and submissions with optional fields omitted (empty inputs are dropped by the FE)', async () => {
      const id = await openBounty();
      const res = await e2e.post(`/bounties/${id}/submissions`, submitBody({ submissionUrl: 'https://demo.example', description: 'd', repositoryUrl: '', commitSha: '' }), { token: user.accessToken });
      expect(res.status).toBe(201);
      const intake = await openBounty(bountyForm({ intakeEnabled: true, reward: { amount: 0, currency: 'INJ' } }));
      expect((await e2e.post(`/bounties/${intake}/applications`, applyBody('hello', ''), { token: user.accessToken })).status).toBe(201);
    });
  });

  describe('rejections', () => {
    it('an unknown field → 400 with the Nest message array (top level and nested reward)', async () => {
      const body = { ...saveAdminBountyBody(bountyForm(), true), slug: 'leaked-form-field' };
      expect((await e2e.post('/admin/bounties', body, asAdmin())).body).toEqual(badRequest(['property slug should not exist']));
      const nested = saveAdminBountyBody(bountyForm(), true);
      nested.reward.custodyAddress = 'inj1attacker';
      expect((await e2e.post('/admin/bounties', nested, asAdmin())).body).toEqual(badRequest(['reward.property custodyAddress should not exist']));
      expect((await e2e.post('/users/me/profile', { nickname: 'okname', bio: 'b', tags: ['DEV'], isAdmin: true }, { token: user.accessToken })).body)
        .toEqual(badRequest(['property isAdmin should not exist']));
      expect((await e2e.post('/auth/refresh', { refreshToken: 'x', userId: 'y' })).body).toEqual(badRequest(['property userId should not exist']));
    });

    it.failing('POST /admin/bounties/:id/transition validates its body like every other write route (unknown field / unknown status → 400)', async () => {
      const id = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ reward: { amount: 0, currency: 'INJ' } }), true), asAdmin())).body.id;
      expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'OPEN', force: true }, asAdmin())).body).toEqual(badRequest(['property force should not exist']));
      expect((await e2e.post(`/admin/bounties/${id}/transition`, {}, asAdmin())).body.message).toEqual(expect.arrayContaining([expect.stringMatching(/^to must be one of the following values: /)]));
      expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'ARCHIVED' }, asAdmin())).status).toBe(400);
      // a known status that is not a legal transition keeps its service code
      expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'COMPLETED' }, asAdmin())).body).toEqual(badRequest('INVALID_TRANSITION:DRAFT->COMPLETED'));
      expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'OPEN' }, asAdmin())).body).toEqual({ id, status: 'OPEN' });
    });

    it('malformed JSON → 400 from the body parser, not a logged 5xx', async () => {
      const before = e2e.linesFor('HttpException').length;
      const res = await e2e.request('POST', '/auth/refresh', { body: '{"refreshToken":', headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(400);
      expect(res.body.statusCode).toBe(400);
      expect(e2e.linesFor('HttpException').length).toBe(before);
    });

    it('oversize fields → 400', async () => {
      const long = (n: number) => 'x'.repeat(n);
      expect((await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: long(201) }), true), asAdmin())).body)
        .toEqual(badRequest(['title must be shorter than or equal to 200 characters']));
      const id = await openBounty(bountyForm({ intakeEnabled: true, reward: { amount: 0, currency: 'INJ' } }));
      expect((await e2e.post(`/bounties/${id}/applications`, applyBody(long(4001)), { token: user.accessToken })).body)
        .toEqual(badRequest(['message must be shorter than or equal to 4000 characters']));
      expect((await e2e.post('/agents', { name: long(101), walletAddress: '0x0000000000000000000000000000000000000001' }, { token: user.accessToken })).body)
        .toEqual(badRequest(['name must be shorter than or equal to 100 characters']));
      expect((await e2e.post('/admin/notices', saveAdminPostBody({ slug: '', title: 't', bodyMarkdown: long(50_001), category: 'OTHER', status: 'draft', thumbnail: null, externalUrl: null }, true), asAdmin())).body.message)
        .toEqual(expect.arrayContaining(['body must be shorter than or equal to 50000 characters']));
      // the JSON body limit itself (express default 100kb) → 413 from body-parser, not a 500
      const huge = await e2e.post('/admin/notices', { title: 't', body: long(200_000), category: 'OTHER' }, asAdmin());
      expect(huge.status).toBe(413);
    });

    it('non-UUID :id → 400 "Validation failed (uuid is expected)" on public, user and admin routes', async () => {
      // bodies are valid so only the :id pipe can fail
      for (const [method, path, token, json] of [
        ['GET', '/bounties/123', undefined, undefined], ['GET', '/notices/abc', undefined, undefined], ['GET', '/media/x', undefined, undefined],
        ['POST', '/bounties/1/applications', user.accessToken, applyBody('hi')], ['POST', '/applications/1/withdraw', user.accessToken, undefined],
        ['PATCH', '/admin/bounties/not-a-uuid', admin.accessToken, { title: 'x' }], ['POST', '/admin/payouts/1/approve', admin.accessToken, undefined],
        ['POST', '/agents/1/verify', user.accessToken, { signature: '0x00' }],
      ] as const) {
        const res = await e2e.request(method, path, { token, json });
        expect([path, res.body]).toEqual([path, badRequest('Validation failed (uuid is expected)')]);
      }
    });

    it('page=abc / pageSize=51 / page=0 → 400 instead of a 500 from Postgres', async () => {
      const abc = await e2e.get('/bounties?page=abc');
      expect(abc.status).toBe(400);
      expect(abc.body.message).toEqual(expect.arrayContaining(['page must be an integer number']));
      expect((await e2e.get('/bounties?pageSize=51')).body).toEqual(badRequest(['pageSize must not be greater than 50']));
      expect((await e2e.get('/notices?page=0')).body).toEqual(badRequest(['page must not be less than 1']));
      expect((await e2e.get('/admin/users?page=-1', asAdmin())).status).toBe(400);
      expect((await e2e.get('/bounties?page=2&pageSize=50')).status).toBe(200);
    });

    it('dangerous URLs are rejected on create and update', async () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x.png']) {
        expect((await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ coverImage: url }), true), asAdmin())).status).toBe(400);
      }
      const id = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm(), true), asAdmin())).body.id;
      const deadline = (await e2e.get('/admin/bounties', asAdmin())).body.find((r: { id: string }) => r.id === id).submission_deadline;
      const res = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody(bountyForm({ slug: id, deadline, coverImage: 'javascript:alert(1)' }), false), asAdmin());
      expect(res.body).toEqual(badRequest(['coverImageUrl must be an http(s) URL or a site-relative path starting with /']));
    });

    it('legacy site-path URL stored before the strict rule: UPDATE resends it and passes (lenient), CREATE rejects it', async () => {
      const id = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm(), true), asAdmin())).body.id;
      await e2e.db.query(`UPDATE bounty SET cover_image_url = '/uploads/legacy-cover.png' WHERE id = $1`, [id]);
      const row = (await e2e.get('/admin/bounties', asAdmin())).body.find((r: { id: string }) => r.id === id);
      const resent = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody(bountyForm({ slug: id, title: 'edited', deadline: row.submission_deadline, coverImage: row.cover_image_url }), false), asAdmin());
      expect(resent.status).toBe(200);
      expect((await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ coverImage: '/uploads/legacy-cover.png' }), true), asAdmin())).body)
        .toEqual(badRequest(['coverImageUrl must be an http(s) URL or a /media/<uuid> path']));
    });

    it('legacy bare-host URL (no scheme) stored before the strict rule: UPDATE resends it and passes (lenient), CREATE rejects it', async () => {
      const id = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm(), true), asAdmin())).body.id;
      await e2e.db.query(`UPDATE bounty SET cover_image_url = 'cdn.ninjalabs.xyz/covers/a.png' WHERE id = $1`, [id]);
      const row = (await e2e.get('/admin/bounties', asAdmin())).body.find((r: { id: string }) => r.id === id);
      const resent = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody(bountyForm({ slug: id, title: 'edited legacy', deadline: row.submission_deadline, coverImage: row.cover_image_url }), false), asAdmin());
      expect(resent.status).toBe(200);
      expect((await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ coverImage: 'cdn.ninjalabs.xyz/covers/a.png' }), true), asAdmin())).body)
        .toEqual(badRequest(['coverImageUrl must be an http(s) URL or a /media/<uuid> path']));

      const notice = (await e2e.post('/admin/notices', saveAdminPostBody({ slug: '', title: 'n', bodyMarkdown: 'b', category: 'OTHER', status: 'draft', thumbnail: null, externalUrl: null }, true), asAdmin())).body.id;
      await e2e.db.query(`UPDATE notice SET external_url = 'www.injective.com/blog', thumbnail_url = 'img.example/t.png' WHERE id = $1`, [notice]);
      const stored = (await e2e.get('/admin/notices', asAdmin())).body.find((r: { id: string }) => r.id === notice);
      const noticePatch = await e2e.patch(`/admin/notices/${notice}`, saveAdminPostBody({ slug: notice, title: 'edited', bodyMarkdown: 'b', category: 'OTHER', status: 'draft', thumbnail: stored.thumbnail_url, externalUrl: stored.external_url }, false), asAdmin());
      expect(noticePatch.status).toBe(200);
    });
  });
});
