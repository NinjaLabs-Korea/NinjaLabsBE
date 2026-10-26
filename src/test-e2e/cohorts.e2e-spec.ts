import { describeDb } from '../test-db/describe-db';
import { E2eApp, Session, startApp, UUID } from './support/harness';

const body = (over: Record<string, unknown> = {}) => ({
  displayName: '홍길동', telegram: 'https://t.me/ninja_kr', twitter: '@ninja_kr', web3Experience: 'Y1_3', activityType: 'DEVELOPER',
  interestAreas: ['DEVELOPER', 'KOL'], intro: 'I want to build on Injective.', ...over,
});
const NIL = '00000000-0000-4000-8000-000000000000';
const HOUR = 3_600_000;

// 기수 모집 + 공지 행사 날짜, HTTP 경계: 인증/권한, 검증, 응답 모양, 경쟁, CSV
describeDb('cohort recruitment over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  let asAdmin: { token: string };
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
    asAdmin = { token: admin.accessToken };
  });
  const closeAll = () => e2e.db.query(`UPDATE cohort SET status = 'CLOSED' WHERE status = 'OPEN'`);
  beforeEach(closeAll);
  afterAll(async () => { await closeAll(); await e2e?.close(); });

  async function openCohort(extra: Record<string, unknown> = {}) {
    const created = await e2e.post('/admin/cohorts', { name: `2기-${Math.random().toString(36).slice(2, 8)}`, ...extra }, asAdmin);
    expect(created.status).toBe(201);
    const opened = await e2e.post(`/admin/cohorts/${created.body.id}/transition`, { to: 'OPEN' }, asAdmin);
    expect(opened.status).toBe(201);
    return created.body.id as string;
  }

  it('GET /cohorts/current is public, answers a literal JSON null with no OPEN cohort, then the cohort shape', async () => {
    const none = await e2e.get('/cohorts/current');
    expect(none.status).toBe(200);
    expect(none.text).toBe('null');
    expect(none.body).toBeNull();

    const id = await openCohort({ description: 'next', closesAt: new Date(Date.now() + HOUR).toISOString() });
    const cur = await e2e.get('/cohorts/current');
    expect(cur.body).toEqual({ id, name: expect.any(String), description: 'next', opensAt: null, closesAt: expect.any(String), acceptingApplications: true });
    expect(Object.keys(cur.body).sort()).toEqual(['acceptingApplications', 'closesAt', 'description', 'id', 'name', 'opensAt']);
  });

  it('permission boundaries: anonymous 401 on user routes; a signed-in non-admin gets 403 ADMIN_ONLY on admin routes', async () => {
    const user = await e2e.loginOnboarded();
    const asUser = { token: user.accessToken };
    for (const [method, path] of [
      ['POST', `/cohorts/${NIL}/applications`], ['GET', '/cohorts/applications/me'], ['PATCH', `/cohorts/applications/${NIL}`], ['POST', `/cohorts/applications/${NIL}/withdraw`],
      ['GET', '/admin/cohorts'], ['POST', '/admin/cohorts'], ['GET', `/admin/cohorts/${NIL}`], ['PATCH', `/admin/cohorts/${NIL}`], ['DELETE', `/admin/cohorts/${NIL}`],
      ['POST', `/admin/cohorts/${NIL}/transition`], ['GET', `/admin/cohorts/${NIL}/applications`], ['GET', `/admin/cohorts/${NIL}/applications.csv`], ['POST', `/admin/cohort-applications/${NIL}/review`],
    ] as const) {
      expect((await e2e.request(method, path, {})).status).toBe(401);
      if (path.startsWith('/admin')) {
        const res = await e2e.request(method, path, { token: user.accessToken });
        expect([res.status, res.body.message]).toEqual([403, 'ADMIN_ONLY']);
      }
    }
    expect((await e2e.get('/cohorts/applications/me', asUser)).body).toEqual([]);
  });

  it('admin cohort lifecycle over HTTP: create, read, update, transition rules, delete', async () => {
    const bad = await e2e.post('/admin/cohorts', { name: 'x', opensAt: '2026-11-02T00:00:00Z', closesAt: '2026-11-01T00:00:00Z' }, asAdmin);
    expect([bad.status, bad.body.message]).toEqual([400, 'COHORT_INVALID_WINDOW']);
    expect((await e2e.post('/admin/cohorts', { name: '   ' }, asAdmin)).status).toBe(400);
    expect((await e2e.post('/admin/cohorts', { name: 'x'.repeat(61) }, asAdmin)).status).toBe(400);
    expect((await e2e.post('/admin/cohorts', { name: 'x', status: 'OPEN' }, asAdmin)).status).toBe(400); // forbidNonWhitelisted
    expect((await e2e.post('/admin/cohorts', { name: 'x', opensAt: 'not-a-date' }, asAdmin)).status).toBe(400);

    const created = await e2e.post('/admin/cohorts', { name: '3기', description: 'd' }, asAdmin);
    expect(created.body).toMatchObject({ id: expect.stringMatching(UUID), name: '3기', status: 'DRAFT', allowedTransitions: ['OPEN'], acceptingApplications: false, applicationCounts: { total: 0 } });
    const id = created.body.id;
    expect((await e2e.get(`/admin/cohorts/${id}`, asAdmin)).body.id).toBe(id);
    expect((await e2e.get('/admin/cohorts', asAdmin)).body.map((c: { id: string }) => c.id)).toContain(id);
    expect((await e2e.patch(`/admin/cohorts/${id}`, { name: null }, asAdmin)).status).toBe(400);
    expect((await e2e.patch(`/admin/cohorts/${id}`, { name: '3기 (수정)', description: null }, asAdmin)).body).toMatchObject({ name: '3기 (수정)', description: null });
    expect((await e2e.get(`/admin/cohorts/${NIL}`, asAdmin)).body.message).toBe('COHORT_NOT_FOUND');
    expect((await e2e.get('/admin/cohorts/not-a-uuid', asAdmin)).status).toBe(400);

    expect((await e2e.post(`/admin/cohorts/${id}/transition`, { to: 'DRAFT' }, asAdmin)).status).toBe(400);
    const closeDraft = await e2e.post(`/admin/cohorts/${id}/transition`, { to: 'CLOSED' }, asAdmin);
    expect([closeDraft.status, closeDraft.body.message]).toEqual([400, 'COHORT_INVALID_TRANSITION']);

    const first = await openCohort();
    const second = await e2e.post(`/admin/cohorts/${id}/transition`, { to: 'OPEN' }, asAdmin);
    expect([second.status, second.body.message]).toEqual([409, 'COHORT_ALREADY_OPEN']);
    expect((await e2e.post(`/admin/cohorts/${first}/transition`, { to: 'CLOSED' }, asAdmin)).body.status).toBe('CLOSED');
    expect((await e2e.post(`/admin/cohorts/${id}/transition`, { to: 'OPEN' }, asAdmin)).body.status).toBe('OPEN');
    expect((await e2e.post(`/admin/cohorts/${first}/transition`, { to: 'OPEN' }, asAdmin)).body.message).toBe('COHORT_ALREADY_OPEN');

    expect((await e2e.delete(`/admin/cohorts/${NIL}`, asAdmin)).body.message).toBe('COHORT_NOT_FOUND');
    await closeAll();
    const empty = (await e2e.post('/admin/cohorts', { name: 'tmp' }, asAdmin)).body.id;
    expect((await e2e.delete(`/admin/cohorts/${empty}`, asAdmin)).body).toEqual({ id: empty });
  });

  it('applying: validation (400), profile (409), not accepting (409), duplicate (409) and the created shape', async () => {
    const cohortId = await openCohort();
    const user = await e2e.loginOnboarded();
    const asUser = { token: user.accessToken };
    const apply = (json: unknown, token = user.accessToken, id = cohortId) => e2e.post(`/cohorts/${id}/applications`, json, { token });

    for (const bad of [
      body({ telegram: 'ab' }), body({ twitter: 'way_too_long_for_twitter' }), body({ web3Experience: 'x' }), body({ activityType: 'NINJA' }),
      body({ interestAreas: [] }), body({ interestAreas: ['STUDENT'] }), body({ displayName: '' }), body({ intro: '  ' }), body({ intro: 'x'.repeat(1001) }),
      body({ status: 'ACCEPTED' }), body({ userId: NIL }),
    ]) expect((await apply(bad)).status).toBe(400);
    const noOther = await apply(body({ activityType: 'OTHER' }));
    expect([noOther.status, noOther.body.message]).toEqual([400, 'COHORT_OTHER_DETAIL_REQUIRED']);
    expect((await apply(body(), user.accessToken, 'not-a-uuid')).status).toBe(400);
    expect((await apply(body(), user.accessToken, NIL)).body.message).toBe('COHORT_NOT_FOUND');

    const fresh = await e2e.login(); // onboarding not finished
    const notReady = await apply(body(), fresh.accessToken);
    expect([notReady.status, notReady.body.message]).toEqual([409, 'PROFILE_REQUIRED']);

    const ok = await apply(body({ activityType: 'OTHER', activityTypeOther: 'farmer', interestAreas: ['OTHER', 'OTHER'], interestOther: 'art' }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      id: expect.stringMatching(UUID), cohortId, status: 'SUBMITTED', displayName: '홍길동', telegram: '@ninja_kr', twitter: '@ninja_kr', web3Experience: 'Y1_3',
      activityType: 'OTHER', activityTypeOther: 'farmer', interestAreas: ['OTHER'], interestOther: 'art', editable: true, withdrawable: true,
      cohort: { id: cohortId, status: 'OPEN', acceptingApplications: true },
    });
    expect(ok.body).not.toHaveProperty('reviewNote');

    const dup = await apply(body());
    expect([dup.status, dup.body.message]).toEqual([409, 'COHORT_ALREADY_APPLIED']);

    await e2e.post(`/admin/cohorts/${cohortId}/transition`, { to: 'CLOSED' }, asAdmin);
    const other = await e2e.loginOnboarded();
    const closed = await apply(body(), other.accessToken);
    expect([closed.status, closed.body.message]).toEqual([409, 'COHORT_NOT_ACCEPTING']);
    expect((await e2e.get('/cohorts/applications/me', asUser)).body).toHaveLength(1);
  });

  it('concurrent POSTs from one user create exactly one application (one 201, the rest 409 COHORT_ALREADY_APPLIED)', async () => {
    const cohortId = await openCohort();
    const user = await e2e.loginOnboarded();
    const responses = await Promise.all(Array.from({ length: 8 }, () => e2e.post(`/cohorts/${cohortId}/applications`, body(), { token: user.accessToken })));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of responses.filter((x) => x.status !== 201)) expect([r.status, r.body.message]).toEqual([409, 'COHORT_ALREADY_APPLIED']);
    const count = await e2e.db.query(`SELECT 1 FROM cohort_application WHERE cohort_id = $1 AND user_id = $2`, [cohortId, user.userId]);
    expect(count.rowCount).toBe(1);
  });

  it('PATCH and withdraw: owner only, SUBMITTED only, accepting only; the review note never reaches the applicant', async () => {
    const cohortId = await openCohort();
    const me = await e2e.loginOnboarded();
    const stranger = await e2e.loginOnboarded();
    const id: string = (await e2e.post(`/cohorts/${cohortId}/applications`, body(), { token: me.accessToken })).body.id;
    const patch = (json: unknown, token = me.accessToken) => e2e.patch(`/cohorts/applications/${id}`, json, { token });

    expect((await patch({ intro: 'hacked' }, stranger.accessToken)).body.message).toBe('COHORT_APPLICATION_NOT_FOUND');
    expect((await e2e.post(`/cohorts/applications/${id}/withdraw`, {}, { token: stranger.accessToken })).status).toBe(404);
    for (const bad of [{ intro: null }, { telegram: 'x' }, { interestAreas: [] }, { status: 'ACCEPTED' }, { activityType: 'OTHER' }]) expect((await patch(bad)).status).toBe(400);
    const edited = await patch({ intro: 'edited', telegram: '@new_handle', interestAreas: ['RESEARCHER'] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id, intro: 'edited', telegram: '@new_handle', interestAreas: ['RESEARCHER'], displayName: '홍길동' });
    expect((await patch({})).status).toBe(200);

    const reviewed = await e2e.post(`/admin/cohort-applications/${id}/review`, { decision: 'REJECTED', note: 'internal: bot-like' }, asAdmin);
    expect(reviewed.body).toMatchObject({ status: 'REJECTED', reviewNote: 'internal: bot-like', user: { id: me.userId } });
    const mine = await e2e.get('/cohorts/applications/me', { token: me.accessToken });
    expect(mine.body[0]).toMatchObject({ id, status: 'REJECTED', editable: false, withdrawable: false });
    expect(mine.text).not.toContain('internal: bot-like');
    expect(mine.text).not.toContain('reviewNote');
    expect((await patch({ intro: 'late' })).body.message).toBe('COHORT_APPLICATION_NOT_SUBMITTED');
    expect((await e2e.post(`/cohorts/applications/${id}/withdraw`, {}, { token: me.accessToken })).body.message).toBe('COHORT_APPLICATION_NOT_SUBMITTED');

    // 결정 변경 허용: REJECTED -> ACCEPTED
    const changed = await e2e.post(`/admin/cohort-applications/${id}/review`, { decision: 'ACCEPTED' }, asAdmin);
    expect(changed.body).toMatchObject({ status: 'ACCEPTED', reviewNote: null });
  });

  it('withdraw -> apply again reopens the same application; closing the cohort blocks edits but not withdrawing', async () => {
    const cohortId = await openCohort();
    const me = await e2e.loginOnboarded();
    const asMe = { token: me.accessToken };
    const id: string = (await e2e.post(`/cohorts/${cohortId}/applications`, body(), asMe)).body.id;
    expect((await e2e.post(`/cohorts/applications/${id}/withdraw`, {}, asMe)).body).toMatchObject({ id, status: 'WITHDRAWN' });
    const review = await e2e.post(`/admin/cohort-applications/${id}/review`, { decision: 'ACCEPTED' }, asAdmin);
    expect([review.status, review.body.message]).toEqual([409, 'COHORT_APPLICATION_WITHDRAWN']);
    const again = await e2e.post(`/cohorts/${cohortId}/applications`, body({ intro: 'again' }), asMe);
    expect(again.body).toMatchObject({ id, status: 'SUBMITTED', intro: 'again' });
    await e2e.post(`/admin/cohorts/${cohortId}/transition`, { to: 'CLOSED' }, asAdmin);
    const late = await e2e.patch(`/cohorts/applications/${id}`, { intro: 'x' }, asMe);
    expect([late.status, late.body.message]).toEqual([409, 'COHORT_NOT_ACCEPTING']);
    expect((await e2e.post(`/cohorts/applications/${id}/withdraw`, {}, asMe)).body.status).toBe('WITHDRAWN');
    const del = await e2e.delete(`/admin/cohorts/${cohortId}`, asAdmin);
    expect([del.status, del.body.message]).toEqual([409, 'COHORT_HAS_APPLICATIONS']);
  });

  it('admin list: filters, search, pagination shape, validation of query params', async () => {
    const cohortId = await openCohort();
    const mk = async (over: Record<string, unknown>) => {
      const u = await e2e.loginOnboarded();
      return (await e2e.post(`/cohorts/${cohortId}/applications`, body(over), { token: u.accessToken })).body.id as string;
    };
    const a = await mk({ displayName: 'Alice Kim', activityType: 'KOL', interestAreas: ['KOL'] });
    const b = await mk({ displayName: 'Bob Lee', telegram: '@bob_lee_tg', activityType: 'STUDENT', interestAreas: ['BIZDEV', 'RESEARCHER'] });
    await e2e.post(`/admin/cohort-applications/${b}/review`, { decision: 'ACCEPTED' }, asAdmin);

    const list = (qs = '') => e2e.get(`/admin/cohorts/${cohortId}/applications${qs}`, asAdmin);
    const all = await list();
    expect(all.body).toMatchObject({ page: 1, pageSize: 30, total: 2 });
    expect(all.body.items[0]).toEqual(expect.objectContaining({ id: expect.stringMatching(UUID), status: expect.any(String), user: { id: expect.any(String), nickname: expect.any(String), email: expect.any(String) } }));
    expect((await list('?status=ACCEPTED')).body.items.map((i: { id: string }) => i.id)).toEqual([b]);
    expect((await list('?activityType=KOL')).body.items.map((i: { id: string }) => i.id)).toEqual([a]);
    expect((await list('?interestArea=BIZDEV')).body.items.map((i: { id: string }) => i.id)).toEqual([b]);
    expect((await list('?q=bob_lee')).body.total).toBe(1);
    expect((await list('?q=alice')).body.items[0].id).toBe(a);
    expect((await list('?page=2&pageSize=1')).body).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    for (const qs of ['?status=PENDING', '?activityType=X', '?interestArea=STUDENT', '?page=0', '?pageSize=51', `?q=${'x'.repeat(321)}`, '?foo=1']) expect((await list(qs)).status).toBe(400);
    expect((await e2e.get(`/admin/cohorts/${NIL}/applications`, asAdmin)).body.message).toBe('COHORT_NOT_FOUND');

    const review = (json: unknown, id = a) => e2e.post(`/admin/cohort-applications/${id}/review`, json, asAdmin);
    for (const bad of [{}, { decision: 'SUBMITTED' }, { decision: 'WITHDRAWN' }, { decision: 'ACCEPTED', note: 'x'.repeat(2001) }, { decision: 'ACCEPTED', extra: 1 }]) expect((await review(bad)).status).toBe(400);
    expect((await review({ decision: 'ACCEPTED' }, NIL)).body.message).toBe('COHORT_APPLICATION_NOT_FOUND');
    expect((await review({ decision: 'ACCEPTED', note: '  looks good ' })).body).toMatchObject({ status: 'ACCEPTED', reviewNote: 'looks good', reviewedBy: admin.userId });
    // accepting does not make anyone a member
    const member = await e2e.db.query(`SELECT is_member FROM "user" u JOIN cohort_application a ON a.user_id = u.id WHERE a.id = $1`, [a]);
    expect(member.rows[0].is_member).toBe(false);
  });

  it('CSV export: headers, BOM, filters, escaping and formula-injection neutralization', async () => {
    const cohortId = await openCohort();
    const u = await e2e.loginOnboarded();
    const evil = await e2e.post(`/cohorts/${cohortId}/applications`, body({
      displayName: '=HYPERLINK("http://evil.example","click")', intro: '@SUM(1+1)\nsecond, "line"', activityType: 'OTHER', activityTypeOther: '+cmd|calc', interestAreas: ['OTHER'], interestOther: '-2+3',
    }), { token: u.accessToken });
    expect(evil.status).toBe(201);
    await e2e.post(`/admin/cohort-applications/${evil.body.id}/review`, { decision: 'REJECTED', note: '=1+1' }, asAdmin);

    const res = await e2e.get(`/admin/cohorts/${cohortId}/applications.csv`, asAdmin);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('"id","applied_at","status","display_name"');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(res.text).toContain(`"'@SUM(1+1)\nsecond, ""line"""`);
    expect(res.text).toContain(`"'+cmd|calc"`);
    expect(res.text).toContain(`"'-2+3"`);
    expect(res.text).toContain(`"'=1+1"`);
    expect(res.text).not.toMatch(/(^|,)"[=+\-@]/m);
    expect(res.text.split('\r\n').filter(Boolean)).toHaveLength(2);

    const none = await e2e.get(`/admin/cohorts/${cohortId}/applications.csv?status=ACCEPTED`, asAdmin);
    expect(none.status).toBe(200);
    expect(none.text.split('\r\n').filter(Boolean)).toHaveLength(1); // header only
    expect((await e2e.get(`/admin/cohorts/${NIL}/applications.csv`, asAdmin)).body.message).toBe('COHORT_NOT_FOUND');
    expect((await e2e.get(`/admin/cohorts/${cohortId}/applications.csv?status=bogus`, asAdmin)).status).toBe(400);
  });

  it('account withdrawal (DELETE /users/me) withdraws a SUBMITTED application and keeps the row', async () => {
    const cohortId = await openCohort();
    const session = await e2e.login();
    const { nickname } = await e2e.onboard(session);
    const id: string = (await e2e.post(`/cohorts/${cohortId}/applications`, body(), { token: session.accessToken })).body.id;
    const ok = await e2e.request('DELETE', '/users/me', { json: { confirmNickname: nickname }, token: session.accessToken });
    expect(ok.status).toBe(200);
    const row = await e2e.db.query(`SELECT status, user_id FROM cohort_application WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'WITHDRAWN', user_id: session.userId });
    const listed = await e2e.get(`/admin/cohorts/${cohortId}/applications`, asAdmin);
    expect(listed.body.items[0]).toMatchObject({ id, status: 'WITHDRAWN' });
    expect(listed.body.items[0].user.nickname).toMatch(/^withdrawn_/);
  });

  it('application writes are limited to 10 per minute per IP', async () => {
    const cohortId = await openCohort();
    const user = await e2e.loginOnboarded();
    const ip = '198.51.100.77';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await e2e.post(`/cohorts/${cohortId}/applications`, body({ telegram: 'x' }), { token: user.accessToken, ip })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses[10]).toBe(429);
  });
});

describeDb('notice event date over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let asAdmin: { token: string };
  beforeAll(async () => { e2e = await startApp(); asAdmin = { token: (await e2e.loginAdmin()).accessToken }; });
  afterAll(async () => e2e?.close());

  const notice = (extra: Record<string, unknown> = {}) => ({ title: `Event ${Math.random().toString(36).slice(2, 8)}`, body: 'details', category: 'EVENT', publish: true, ...extra });

  it('admin create/update validate real calendar dates; public list and detail return event_date', async () => {
    for (const eventDate of ['2026-02-30', '2026-13-01', '2026-10-26T00:00:00Z', 'soon', 20261026]) {
      expect((await e2e.post('/admin/notices', notice({ eventDate }), asAdmin)).status).toBe(400);
    }
    const created = await e2e.post('/admin/notices', notice({ eventDate: '2026-03-14' }), asAdmin);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await e2e.get(`/notices/${id}`)).body.event_date).toBe('2026-03-14');
    const listed = await e2e.get('/notices?category=EVENT&pageSize=50');
    expect(listed.body.items.find((n: { id: string }) => n.id === id).event_date).toBe('2026-03-14');
    expect((await e2e.patch(`/admin/notices/${id}`, { eventDate: '2026-02-30' }, asAdmin)).status).toBe(400);
    expect((await e2e.patch(`/admin/notices/${id}`, { eventDate: '2026-04-01' }, asAdmin)).status).toBe(200);
    expect((await e2e.get(`/notices/${id}`)).body.event_date).toBe('2026-04-01');
    expect((await e2e.get('/admin/notices', asAdmin)).body.find((n: { id: string }) => n.id === id).event_date).toBe('2026-04-01');
    expect((await e2e.patch(`/admin/notices/${id}`, { eventDate: null }, asAdmin)).status).toBe(200);
    expect((await e2e.get(`/notices/${id}`)).body.event_date).toBeNull();
  });

  it('GET /notices?sort=eventDate orders by event date desc with undated last; other callers keep the old order; bad sort is 400', async () => {
    const early = (await e2e.post('/admin/notices', notice({ eventDate: '2026-01-05' }), asAdmin)).body.id;
    const late = (await e2e.post('/admin/notices', notice({ eventDate: '2026-12-25' }), asAdmin)).body.id;
    const undated = (await e2e.post('/admin/notices', notice(), asAdmin)).body.id;
    const mine = [early, late, undated];
    const order = async (qs: string) => (await e2e.get(`/notices?${qs}&pageSize=50`)).body.items.map((n: { id: string }) => n.id).filter((id: string) => mine.includes(id));
    expect(await order('category=EVENT&sort=eventDate')).toEqual([late, early, undated]);
    expect(await order('category=EVENT')).toEqual([undated, late, early]); // newest published first, unchanged
    expect(await order('sort=eventDate')).toEqual([late, early, undated]);
    expect((await e2e.get('/notices?sort=title')).status).toBe(400);
  });
});
