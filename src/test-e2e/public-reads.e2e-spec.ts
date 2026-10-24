import { describeDb } from '../test-db/describe-db';
import { AdminBountyForm, saveAdminBountyBody, saveAdminHighlightBody, saveAdminPostBody, setAdminMemberBody, submitBody } from './support/fe-payloads';
import { DAY, E2eApp, isoIn, Session, startApp, txHash } from './support/harness';

function bountyForm(overrides: Partial<AdminBountyForm> = {}): AdminBountyForm {
  return {
    slug: '', title: 'Public bounty', sponsor: 'Public Sponsor', description: 'desc', requirements: 'req', reviewProcess: 'rev',
    tags: ['Content'], intakeEnabled: false, maxWinners: 1, submissionMode: 'direct', coverImage: null,
    deadline: isoIn(20 * DAY), reward: { amount: 0, currency: 'INJ' }, ...overrides,
  };
}

// j. public reads — the shapes NinjaLabsFE/src/lib/{bounties,members,notices,hall-of-fame}.ts parse
describeDb('public reads over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
  });
  afterAll(async () => e2e?.close());
  const asAdmin = () => ({ token: admin.accessToken });

  async function openBounty(form = bountyForm()): Promise<string> {
    const id = (await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), asAdmin())).body.id;
    expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'OPEN' }, asAdmin())).status).toBe(201);
    return id;
  }

  it('GET /bounties/:id and GET /bounties expose an explicit column list — no created_by / sponsor_user_id / deleted_at; every field the FE BountyDetailRow reads is present', async () => {
    const id = await openBounty(bountyForm({ title: 'Column list' }));
    const detail = await e2e.get(`/bounties/${id}`);
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual([
      'application_deadline', 'application_required', 'attachments', 'category', 'completed_at', 'cover_image_url', 'created_at', 'description',
      'evaluation_criteria', 'id', 'max_winners', 'opened_at', 'requirements', 'review_started_at', 'rewards', 'sponsor_name', 'status',
      'submission_deadline', 'submission_mode', 'summary', 'title', 'updated_at',
    ]);
    // NinjaLabsFE src/lib/bounties.ts BountyListRow + BountyDetailRow
    for (const field of ['id', 'title', 'summary', 'sponsor_name', 'category', 'status', 'application_required', 'submission_mode', 'cover_image_url',
      'application_deadline', 'submission_deadline', 'rewards', 'description', 'requirements', 'evaluation_criteria']) {
      expect(detail.body).toHaveProperty(field);
    }
    const listed = (await e2e.get('/bounties?pageSize=50')).body.items.find((b: { id: string }) => b.id === id);
    for (const internal of ['created_by', 'sponsor_user_id', 'deleted_at']) {
      expect(detail.body).not.toHaveProperty(internal);
      expect(listed).not.toHaveProperty(internal);
    }
  });

  it('GET /bounties pages with pageSize=50 like fetchAllPublicPages: {items,page,pageSize,total}, disjoint pages, drafts hidden', async () => {
    for (let i = 0; i < 52; i++) await openBounty(bountyForm({ title: `Paged ${i}` }));
    const draft = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: 'Hidden draft' }), true), asAdmin())).body.id;
    const funding = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: 'Hidden funding', reward: { amount: 1, currency: 'INJ' } }), true), asAdmin())).body.id;

    const visible = await e2e.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty WHERE deleted_at IS NULL AND opened_at IS NOT NULL`);
    const page1 = await e2e.get('/bounties?page=1&pageSize=50');
    expect(page1.status).toBe(200);
    expect(Object.keys(page1.body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(page1.body).toMatchObject({ page: 1, pageSize: 50, total: visible.rows[0].n });
    expect(page1.body.items).toHaveLength(50);
    expect(Object.keys(page1.body.items[0]).sort()).toEqual([
      'application_deadline', 'application_required', 'category', 'cover_image_url', 'id', 'max_winners', 'opened_at',
      'rewards', 'sponsor_name', 'status', 'submission_deadline', 'submission_mode', 'summary', 'title',
    ]);
    const opened = page1.body.items.map((b: { opened_at: string }) => new Date(b.opened_at).getTime());
    expect([...opened].sort((a, b) => b - a)).toEqual(opened);

    const page2 = await e2e.get('/bounties?page=2&pageSize=50');
    expect(page2.body.items).toHaveLength(Math.min(50, visible.rows[0].n - 50));
    const ids1 = new Set(page1.body.items.map((b: { id: string }) => b.id));
    expect(page2.body.items.some((b: { id: string }) => ids1.has(b.id))).toBe(false);
    const all = [...page1.body.items, ...page2.body.items].map((b: { id: string }) => b.id);
    expect(all).not.toContain(draft);
    expect(all).not.toContain(funding);

    expect((await e2e.get('/bounties?pageSize=5&category=CONTENT&status=OPEN')).body.items.every((b: { category: string; status: string }) => b.category === 'CONTENT' && b.status === 'OPEN')).toBe(true);
    expect((await e2e.get('/bounties')).body.pageSize).toBe(12);
  });

  it('paging is stable when the sort key ties: every visible bounty appears exactly once across pages (40 bounties opened in the same instant)', async () => {
    const tied: string[] = [];
    for (let i = 0; i < 40; i++) tied.push(await openBounty(bountyForm({ title: `Tied ${i}` })));
    await e2e.db.query(`UPDATE bounty SET opened_at = '2030-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [tied]);
    const expected = await e2e.db.query<{ id: string }>(
      `SELECT id FROM bounty WHERE deleted_at IS NULL AND opened_at IS NOT NULL
        ORDER BY opened_at DESC, created_at DESC, id`);
    const total = (await e2e.get('/bounties?pageSize=1')).body.total;
    // the order is fully defined: opened_at DESC, then newest created first, then id — so pages can never overlap
    const walked: string[] = [];
    for (let page = 1; (page - 1) * 50 < total; page++) {
      walked.push(...(await e2e.get(`/bounties?page=${page}&pageSize=50`)).body.items.map((b: { id: string }) => b.id));
    }
    expect(walked).toEqual(expected.rows.map((r) => r.id));
    expect(total).toBe(expected.rowCount);
    // walk the list with several page sizes — each walk must return every row exactly once
    for (const size of [3, 7, 11, 13, 50]) {
      const seen: string[] = [];
      for (let page = 1; (page - 1) * size < total; page++) {
        seen.push(...(await e2e.get(`/bounties?page=${page}&pageSize=${size}`)).body.items.map((b: { id: string }) => b.id));
      }
      expect({ size, unique: new Set(seen).size }).toEqual({ size, unique: total });
      expect([...seen].sort()).toEqual(expected.rows.map((r) => r.id).sort());
    }

    // notices: same published_at (several published in one millisecond, or by a bulk import)
    const noticeIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      noticeIds.push((await e2e.post('/admin/notices', saveAdminPostBody({ slug: '', title: `Tied ${i}`, bodyMarkdown: 'b', category: 'OTHER', status: 'published', thumbnail: null, externalUrl: null }, true), asAdmin())).body.id);
    }
    await e2e.db.query(`UPDATE notice SET published_at = '2030-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [noticeIds]);
    const noticeTotal = (await e2e.get('/notices?pageSize=1')).body.total;
    for (const size of [2, 5, 7]) {
      const noticesSeen: string[] = [];
      for (let page = 1; (page - 1) * size < noticeTotal; page++) {
        noticesSeen.push(...(await e2e.get(`/notices?page=${page}&pageSize=${size}`)).body.items.map((n: { id: string }) => n.id));
      }
      expect({ size, unique: new Set(noticesSeen).size }).toEqual({ size, unique: noticeTotal });
      expect(noticesSeen.slice(0, 12).sort()).toEqual([...noticeIds].sort()); // the far-future tie sorts first
    }
    const firstPage = (await e2e.get('/notices?pageSize=12')).body.items.map((n: { id: string }) => n.id);
    expect(firstPage).toEqual([...noticeIds].reverse()); // tie → newest created first
  });

  it('a bounty cancelled before it ever opened stays private (list excludes it, detail 404); one cancelled after opening stays public', async () => {
    const draft = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: 'Cancelled draft' }), true), asAdmin())).body.id;
    const funding = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: 'Cancelled funding', reward: { amount: 1, currency: 'INJ' } }), true), asAdmin())).body.id;
    for (const id of [draft, funding]) {
      expect((await e2e.post(`/admin/bounties/${id}/transition`, { to: 'CANCELLED' }, asAdmin())).body).toEqual({ id, status: 'CANCELLED' });
    }
    const opened = await openBounty(bountyForm({ title: 'Cancelled after opening' }));
    expect((await e2e.post(`/admin/bounties/${opened}/transition`, { to: 'CANCELLED' }, asAdmin())).body).toEqual({ id: opened, status: 'CANCELLED' });

    const listedIds = async (query: string) => {
      const ids: string[] = [];
      const total = (await e2e.get(`/bounties?pageSize=1${query}`)).body.total;
      for (let page = 1; (page - 1) * 50 < total; page++) {
        ids.push(...(await e2e.get(`/bounties?page=${page}&pageSize=50${query}`)).body.items.map((b: { id: string }) => b.id));
      }
      return ids;
    };
    for (const query of ['', '&status=CANCELLED']) {
      const ids = await listedIds(query);
      expect(ids).not.toContain(draft);
      expect(ids).not.toContain(funding);
      expect(ids).toContain(opened);
    }
    for (const id of [draft, funding]) {
      expect((await e2e.get(`/bounties/${id}`)).body).toEqual({ statusCode: 404, error: 'Not Found', message: 'BOUNTY_NOT_FOUND' });
    }
    const detail = await e2e.get(`/bounties/${opened}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: opened, status: 'CANCELLED', title: 'Cancelled after opening' });
    expect(detail.body.opened_at).toEqual(expect.any(String));
    // the operator still sees all three
    const adminIds = (await e2e.get('/admin/bounties', asAdmin())).body.map((b: { id: string }) => b.id);
    expect(adminIds).toEqual(expect.arrayContaining([draft, funding, opened]));
  });

  it('GET /users/:nickname: payoutStatus NONE (no reward) / PENDING (reward, not yet paid) with postedRewards; unknown or suspended → 404', async () => {
    const builder = await e2e.login();
    const { nickname } = await e2e.onboard(builder);
    const noReward = await openBounty(bountyForm({ title: 'No reward' }));
    const withReward = (await e2e.post('/admin/bounties', saveAdminBountyBody(bountyForm({ title: 'With reward', reward: { amount: 2.5, currency: 'USDC' } }), true), asAdmin())).body.id;
    const rewardId = (await e2e.get(`/admin/bounties/${withReward}/operations`, asAdmin())).body.rewards[0].id;
    await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: txHash(), depositedAmount: '2500000' }, asAdmin());
    await e2e.post(`/admin/bounties/${withReward}/transition`, { to: 'OPEN' }, asAdmin());
    for (const id of [noReward, withReward]) {
      const sub = await e2e.post(`/bounties/${id}/submissions`, submitBody({ submissionUrl: 'https://demo.example', description: 'd' }), { token: builder.accessToken });
      expect((await e2e.post(`/admin/submissions/${sub.body.id}/review`, { decision: 'APPROVE' }, asAdmin())).body.status).toBe('APPROVED');
    }

    const profile = await e2e.get(`/users/${encodeURIComponent(nickname.toUpperCase())}`); // case-insensitive
    expect(profile.status).toBe(200);
    expect(Object.keys(profile.body).sort()).toEqual(['agents', 'bio', 'completedBounties', 'created_at', 'id', 'is_member', 'member_role', 'nfts', 'nickname', 'tags']);
    expect(profile.body).toMatchObject({ nickname, bio: 'builder bio', tags: ['DEV'], is_member: false, agents: [] });
    const byTitle = Object.fromEntries(profile.body.completedBounties.map((b: { title: string }) => [b.title, b]));
    expect(byTitle['No reward']).toMatchObject({ id: noReward, category: 'CONTENT', rewards: [], postedRewards: [], payoutStatus: 'NONE' });
    expect(byTitle['With reward']).toMatchObject({ id: withReward, rewards: [], postedRewards: [{ amount: '2500000', symbol: 'USDC' }], payoutStatus: 'PENDING' });
    expect(profile.body.nfts).toEqual([expect.objectContaining({ nft_type: 'NINJA_PARENT', status: 'PENDING', bounty_title: null })]);

    expect((await e2e.get('/users/nobody-here')).body).toEqual({ statusCode: 404, error: 'Not Found', message: 'USER_NOT_FOUND' });
    await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [builder.userId]);
    expect((await e2e.get(`/users/${encodeURIComponent(nickname)}`)).status).toBe(404);
  });

  it('GET /members lists official members in display order with links', async () => {
    const a = await e2e.login();
    const b = await e2e.login();
    const nickA = (await e2e.onboard(a)).nickname;
    const nickB = (await e2e.onboard(b)).nickname;
    await e2e.post(`/admin/users/${a.userId}/member`, setAdminMemberBody({ isMember: true, role: 'Dev', displayOrder: 20 }), asAdmin());
    await e2e.post(`/admin/users/${b.userId}/member`, setAdminMemberBody({ isMember: true, role: 'Ops', displayOrder: 10 }), asAdmin());
    const res = await e2e.get('/members');
    expect(res.status).toBe(200);
    const mine = res.body.filter((m: { id: string }) => [a.userId, b.userId].includes(m.id));
    expect(mine).toEqual([
      { id: b.userId, nickname: nickB, bio: 'builder bio', member_role: 'OPS', member_display_order: 10, links: [] },
      { id: a.userId, nickname: nickA, bio: 'builder bio', member_role: 'DEV', member_display_order: 20, links: [] },
    ]);
  });

  it('GET /hall-of-fame/stats is cached: the second call issues no query; concurrent cold calls share one', async () => {
    const spy = jest.spyOn(e2e.db, 'query');
    try {
      const statsQueries = () => spy.mock.calls.filter(([sql]) => String(sql).includes('completed_bounties')).length;
      const [first, concurrent] = await Promise.all([e2e.get('/hall-of-fame/stats'), e2e.get('/hall-of-fame/stats')]);
      expect(first.status).toBe(200);
      expect(Object.keys(first.body).sort()).toEqual(['builders', 'completedBounties', 'completionNfts', 'paidTotals', 'sponsors']);
      const { paidTotals, ...counts } = first.body;
      expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true);
      expect(Array.isArray(paidTotals)).toBe(true);
      for (const t of paidTotals) {
        expect(Object.keys(t).sort()).toEqual(['amount', 'decimals', 'symbol', 'tokenType']);
        expect(t.amount).toMatch(/^\d+$/);
      }
      expect(concurrent.body).toEqual(first.body);
      expect(statsQueries()).toBe(1);
      const before = spy.mock.calls.length;
      const second = await e2e.get('/hall-of-fame/stats');
      expect(second.body).toEqual(first.body);
      expect(spy.mock.calls.length).toBe(before); // not even a pool round-trip
    } finally {
      spy.mockRestore();
    }
  });

  it('GET /hall-of-fame lists published highlights only', async () => {
    const pub = (await e2e.post('/admin/highlights', saveAdminHighlightBody({ id: '', type: 'PARTNERSHIP', title: 'Partner', order: 0, image: 'https://cdn.example/logo.png', published: true }, true), asAdmin())).body.id;
    const hidden = (await e2e.post('/admin/highlights', saveAdminHighlightBody({ id: '', type: 'OTHER', title: 'Hidden', order: 0, image: null }, true), asAdmin())).body.id;
    const res = await e2e.get('/hall-of-fame');
    const ids = res.body.map((h: { id: string }) => h.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(hidden);
    expect(Object.keys(res.body[0]).sort()).toEqual(['description', 'display_order', 'id', 'image_url', 'link_url', 'published_at', 'title', 'type']);
  });

  it('GET /notices: drafts hidden; publish sets published_at once (re-publish keeps it: COALESCE), unpublish clears it', async () => {
    const post = { slug: '', title: `Notice ${Date.now()}`, bodyMarkdown: 'Body', category: 'NINJALABS', status: 'draft' as const, thumbnail: null, externalUrl: 'https://injective.com' };
    const id = (await e2e.post('/admin/notices', saveAdminPostBody(post, true), asAdmin())).body.id;
    const listed = async () => (await e2e.get('/notices?pageSize=50')).body.items.find((n: { id: string }) => n.id === id);
    expect(await listed()).toBeUndefined();
    expect((await e2e.get(`/notices/${id}`)).status).toBe(404);

    expect((await e2e.patch(`/admin/notices/${id}`, saveAdminPostBody({ ...post, slug: id }, false, { publish: true }), asAdmin())).body).toEqual({ id, status: 'PUBLISHED' });
    const first = await listed();
    expect(Object.keys(first).sort()).toEqual(['category', 'external_url', 'id', 'published_at', 'summary', 'thumbnail_url', 'title']);
    expect(first).toMatchObject({ title: post.title, summary: 'Body', category: 'NINJALABS', external_url: 'https://injective.com', thumbnail_url: null });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await e2e.patch(`/admin/notices/${id}`, saveAdminPostBody({ ...post, slug: id, title: 'Edited' }, false, { publish: true }), asAdmin());
    const again = await listed();
    expect(again.title).toBe('Edited');
    expect(again.published_at).toBe(first.published_at);
    const detail = await e2e.get(`/notices/${id}`);
    expect(detail.body).toMatchObject({ id, title: 'Edited', body: 'Body', published_at: first.published_at });

    await e2e.patch(`/admin/notices/${id}`, saveAdminPostBody({ ...post, slug: id }, false, { publish: false }), asAdmin());
    expect(await listed()).toBeUndefined();
    const row = (await e2e.get('/admin/notices', asAdmin())).body.find((n: { id: string }) => n.id === id);
    expect(row).toMatchObject({ status: 'DRAFT', published_at: null });

    // deleted notices disappear from the admin list too
    expect((await e2e.delete(`/admin/notices/${id}`, asAdmin())).status).toBe(200);
    expect((await e2e.get('/admin/notices', asAdmin())).body.some((n: { id: string }) => n.id === id)).toBe(false);
  });
});
