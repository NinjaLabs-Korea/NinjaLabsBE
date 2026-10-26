import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import { CohortAdminService } from '../cohorts/cohort-admin.service';
import { CohortApplicationAdminService } from '../cohorts/cohort-application-admin.service';
import { CohortApplicationsService } from '../cohorts/cohort-applications.service';
import { CohortsService } from '../cohorts/cohorts.service';
import { NoticeAdminService } from '../notices/notice-admin.service';
import { NoticesService } from '../notices/notices.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser, TEST_JWT_SECRET, testConfig, unique } from './harness';

const base = {
  displayName: '홍길동', telegram: '@ninja_kr', twitter: '@ninja_kr', web3Experience: 'Y1_3', activityType: 'DEVELOPER',
  interestAreas: ['DEVELOPER', 'KOL'], intro: 'I want to build on Injective.',
};
const HOUR = 3_600_000;

describeDb('cohort recruitment on a real database', () => {
  let db: DatabaseService;
  let cohorts: CohortsService;
  let apps: CohortApplicationsService;
  let admin: CohortAdminService;
  let appAdmin: CohortApplicationAdminService;
  let withdrawal: AccountWithdrawalService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    cohorts = new CohortsService(db);
    apps = new CohortApplicationsService(db, audit);
    admin = new CohortAdminService(db, audit);
    appAdmin = new CohortApplicationAdminService(db, audit);
    const auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }), config, TEST_JWT_SECRET);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
    adminId = await createUser(db, { isAdmin: true });
  });
  // 열린 기수는 DB에서 하나뿐이므로 테스트마다 닫아 둔다
  const closeAll = () => db.query(`UPDATE cohort SET status = 'CLOSED' WHERE status = 'OPEN'`);
  beforeEach(closeAll);
  afterAll(async () => { await closeAll(); await db.onApplicationShutdown(); });

  async function openCohort(window: { opensAt?: string | null; closesAt?: string | null } = {}) {
    const { id } = await admin.create(adminId, { name: unique('c-'), ...window });
    await admin.transition(id, 'OPEN', adminId);
    return id;
  }

  describe('GET /cohorts/current', () => {
    it('is null without an OPEN cohort and ignores DRAFT/CLOSED', async () => {
      await admin.create(adminId, { name: unique('draft-') });
      expect(await cohorts.current()).toBeNull();
    });

    it('reports acceptingApplications from the window: open ends, inside, before opens_at, after closes_at', async () => {
      const id = await openCohort();
      expect(await cohorts.current()).toMatchObject({ id, acceptingApplications: true, opensAt: null, closesAt: null });

      await admin.update(id, adminId, { opensAt: new Date(Date.now() - HOUR).toISOString(), closesAt: new Date(Date.now() + HOUR).toISOString() });
      expect((await cohorts.current())!.acceptingApplications).toBe(true);

      await admin.update(id, adminId, { opensAt: new Date(Date.now() + HOUR).toISOString(), closesAt: null });
      expect(await cohorts.current()).toMatchObject({ id, acceptingApplications: false });

      await admin.update(id, adminId, { opensAt: null, closesAt: new Date(Date.now() - HOUR).toISOString() });
      expect(await cohorts.current()).toMatchObject({ id, acceptingApplications: false });
    });
  });

  describe('applying', () => {
    it('stores a normalized application and returns the applicant view without review fields', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const out = await apps.apply(cohortId, userId, { ...base, activityType: 'OTHER', activityTypeOther: ' farmer ' }) as Record<string, any>;
      expect(out).toMatchObject({ cohortId, status: 'SUBMITTED', activityTypeOther: 'farmer', interestOther: null, editable: true, withdrawable: true });
      expect(out).not.toHaveProperty('reviewNote');
      expect(await auditActions(db, 'cohort_application', out.id)).toEqual(['COHORT_APPLICATION_SUBMITTED']);
    });

    it('PROFILE_REQUIRED for a user who has not finished onboarding; NOT_FOUND for DRAFT/unknown; NOT_ACCEPTING when closed or outside the window', async () => {
      const cohortId = await openCohort();
      await expect(apps.apply(cohortId, await createUser(db, { onboarded: false }), base)).rejects.toMatchObject({ message: 'PROFILE_REQUIRED' });
      const draft = (await admin.create(adminId, { name: unique('d-') })).id;
      await expect(apps.apply(draft, await createUser(db), base)).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
      await expect(apps.apply('00000000-0000-4000-8000-000000000000', await createUser(db), base)).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });

      await admin.update(cohortId, adminId, { opensAt: new Date(Date.now() + HOUR).toISOString() });
      await expect(apps.apply(cohortId, await createUser(db), base)).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
      await admin.update(cohortId, adminId, { opensAt: null });
      await admin.transition(cohortId, 'CLOSED', adminId);
      await expect(apps.apply(cohortId, await createUser(db), base)).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
    });

    it('a second application is COHORT_ALREADY_APPLIED, even after ACCEPTED/REJECTED', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const first = await apps.apply(cohortId, userId, base) as { id: string };
      await expect(apps.apply(cohortId, userId, base)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });
      await appAdmin.review(first.id, 'REJECTED', null, adminId);
      await expect(apps.apply(cohortId, userId, base)).rejects.toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });
    });

    it('concurrent identical applications: exactly one succeeds, the rest are COHORT_ALREADY_APPLIED, one row', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => apps.apply(cohortId, userId, base)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ message: 'COHORT_ALREADY_APPLIED' });
      const rows = await db.query(`SELECT 1 FROM cohort_application WHERE cohort_id = $1 AND user_id = $2`, [cohortId, userId]);
      expect(rows.rowCount).toBe(1);
    });

    it('a withdrawn application is reopened in place (same id, review fields cleared)', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const first = await apps.apply(cohortId, userId, base) as { id: string };
      await apps.withdraw(first.id, userId);
      const again = await apps.apply(cohortId, userId, { ...base, intro: 'second try' }) as { id: string; status: string; intro: string };
      expect(again).toMatchObject({ id: first.id, status: 'SUBMITTED', intro: 'second try' });
      expect(await auditActions(db, 'cohort_application', first.id)).toEqual(expect.arrayContaining(['COHORT_APPLICATION_WITHDRAWN', 'COHORT_APPLICATION_REAPPLIED']));
    });
  });

  describe('my applications, update and withdraw', () => {
    it('lists only my own applications, newest first, with the cohort and never the review note', async () => {
      const cohortId = await openCohort();
      const me = await createUser(db);
      const other = await createUser(db);
      const mine = await apps.apply(cohortId, me, base) as { id: string };
      await apps.apply(cohortId, other, base);
      await appAdmin.review(mine.id, 'ACCEPTED', 'private operator note', adminId);
      const list = await apps.mine(me) as Array<Record<string, any>>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: mine.id, status: 'ACCEPTED', cohort: { id: cohortId }, editable: false, withdrawable: false });
      expect(JSON.stringify(list)).not.toContain('private operator note');
    });

    it('update merges fields and re-checks OTHER details; only the owner, only SUBMITTED, only while accepting', async () => {
      const cohortId = await openCohort();
      const me = await createUser(db);
      const other = await createUser(db);
      const { id } = await apps.apply(cohortId, me, base) as { id: string };

      await expect(apps.update(id, other, { intro: 'x' })).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
      await expect(apps.update(id, me, { interestAreas: ['OTHER'] })).rejects.toMatchObject({ message: 'COHORT_OTHER_DETAIL_REQUIRED' });
      const ok = await apps.update(id, me, { intro: 'edited', interestAreas: ['OTHER'], interestOther: 'robotics' }) as Record<string, any>;
      expect(ok).toMatchObject({ intro: 'edited', interestAreas: ['OTHER'], interestOther: 'robotics', displayName: base.displayName });
      const back = await apps.update(id, me, { interestAreas: ['KOL'] }) as Record<string, any>;
      expect(back.interestOther).toBeNull();

      await appAdmin.review(id, 'REJECTED', null, adminId);
      await expect(apps.update(id, me, { intro: 'late' })).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_SUBMITTED' });
      await expect(apps.withdraw(id, me)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_SUBMITTED' });
    });

    it('after the cohort closes the applicant can still withdraw but no longer edit', async () => {
      const cohortId = await openCohort();
      const me = await createUser(db);
      const { id } = await apps.apply(cohortId, me, base) as { id: string };
      await admin.transition(cohortId, 'CLOSED', adminId);
      await expect(apps.update(id, me, { intro: 'late' })).rejects.toMatchObject({ message: 'COHORT_NOT_ACCEPTING' });
      expect(await apps.withdraw(id, me)).toMatchObject({ status: 'WITHDRAWN' });
      await expect(appAdmin.review(id, 'ACCEPTED', null, adminId)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_WITHDRAWN' });
    });
  });

  describe('admin cohorts', () => {
    it('create/update validate the window; the audit trail records each write', async () => {
      await expect(admin.create(adminId, { name: 'x', opensAt: '2026-11-02T00:00:00Z', closesAt: '2026-11-01T00:00:00Z' })).rejects.toMatchObject({ message: 'COHORT_INVALID_WINDOW' });
      const created = await admin.create(adminId, { name: '2기', description: 'second cohort' }) as { id: string; status: string; allowedTransitions: string[] };
      expect(created).toMatchObject({ status: 'DRAFT', allowedTransitions: ['OPEN'] });
      await expect(admin.update(created.id, adminId, { opensAt: '2026-11-02T00:00:00Z', closesAt: '2026-11-01T00:00:00Z' })).rejects.toMatchObject({ message: 'COHORT_INVALID_WINDOW' });
      await admin.update(created.id, adminId, { description: null });
      await admin.remove(created.id, adminId);
      expect(await auditActions(db, 'cohort', created.id)).toEqual(['COHORT_CREATED', 'COHORT_UPDATED', 'COHORT_DELETED']);
      await expect(admin.detail(created.id)).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
    });

    it('transitions follow DRAFT->OPEN->CLOSED and CLOSED->OPEN; one OPEN cohort at a time', async () => {
      const a = (await admin.create(adminId, { name: unique('a-') })).id;
      const b = (await admin.create(adminId, { name: unique('b-') })).id;
      await expect(admin.transition(a, 'CLOSED', adminId)).rejects.toMatchObject({ message: 'COHORT_INVALID_TRANSITION' });
      await admin.transition(a, 'OPEN', adminId);
      await expect(admin.transition(a, 'OPEN', adminId)).rejects.toMatchObject({ message: 'COHORT_INVALID_TRANSITION' });
      await expect(admin.transition(b, 'OPEN', adminId)).rejects.toMatchObject({ message: 'COHORT_ALREADY_OPEN' });
      await admin.transition(a, 'CLOSED', adminId);
      await admin.transition(b, 'OPEN', adminId);
      await expect(admin.transition(a, 'OPEN', adminId)).rejects.toMatchObject({ message: 'COHORT_ALREADY_OPEN' }); // reopen blocked while b is OPEN
      await admin.transition(b, 'CLOSED', adminId);
      expect(await admin.transition(a, 'OPEN', adminId)).toMatchObject({ status: 'OPEN' });
      expect(await auditActions(db, 'cohort', a)).toEqual(expect.arrayContaining(['COHORT_OPENED', 'COHORT_CLOSED', 'COHORT_REOPENED']));
    });

    it('opening two DRAFT cohorts at once: exactly one wins (partial unique index)', async () => {
      const a = (await admin.create(adminId, { name: unique('r1-') })).id;
      const b = (await admin.create(adminId, { name: unique('r2-') })).id;
      const results = await Promise.allSettled([admin.transition(a, 'OPEN', adminId), admin.transition(b, 'OPEN', adminId)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ message: 'COHORT_ALREADY_OPEN' });
    });

    it('delete is refused once any application exists (even withdrawn) and the list shows counts', async () => {
      const cohortId = await openCohort();
      const me = await createUser(db);
      const { id } = await apps.apply(cohortId, me, base) as { id: string };
      await apps.withdraw(id, me);
      await expect(admin.remove(cohortId, adminId)).rejects.toMatchObject({ message: 'COHORT_HAS_APPLICATIONS' });
      const listed = (await admin.list()).find((c) => c.id === cohortId)!;
      expect(listed.applicationCounts).toEqual({ SUBMITTED: 0, ACCEPTED: 0, REJECTED: 0, WITHDRAWN: 1, total: 1 });
    });

    it('a delete racing an application never leaves an orphan or a 500', async () => {
      const cohortId = await openCohort();
      const me = await createUser(db);
      const results = await Promise.allSettled([apps.apply(cohortId, me, base), admin.remove(cohortId, adminId)]);
      for (const r of results) if (r.status === 'rejected') expect(['COHORT_NOT_FOUND', 'COHORT_HAS_APPLICATIONS']).toContain((r.reason as Error).message);
      const remaining = await db.query(`SELECT (SELECT count(*) FROM cohort WHERE id = $1)::int AS cohorts, (SELECT count(*) FROM cohort_application WHERE cohort_id = $1)::int AS apps`, [cohortId]);
      expect(remaining.rows[0].apps === 0 || remaining.rows[0].cohorts === 1).toBe(true);
    });
  });

  describe('admin applications: list, filter, search, review, CSV', () => {
    async function seed() {
      const cohortId = await openCohort();
      const tag = unique('s');
      const mk = async (nickname: string, over: Record<string, unknown>) => {
        const userId = await createUser(db, { nickname });
        const row = await apps.apply(cohortId, userId, { ...base, ...over }) as { id: string };
        return { userId, id: row.id };
      };
      const a = await mk(`dev_${tag}`, { displayName: '50%_off', activityType: 'DEVELOPER', interestAreas: ['DEVELOPER'] });
      const b = await mk(`kol_${tag}`, { displayName: 'Bob', telegram: '@bob_tele', activityType: 'KOL', interestAreas: ['KOL', 'BIZDEV'] });
      const c = await mk(`stu_${tag}`, { displayName: '=HYPERLINK("http://evil")', twitter: '@carol_x', activityType: 'STUDENT', interestAreas: ['RESEARCHER'], intro: 'line1\nline2 "quoted", and a comma' });
      await appAdmin.review(c.id, 'ACCEPTED', '+cmd|calc', adminId);
      return { cohortId, tag, a, b, c };
    }

    it('filters by status / activity type / interest area and searches name, telegram, twitter, nickname, email (LIKE metacharacters are literal)', async () => {
      const { cohortId, tag, a, b, c } = await seed();
      const ids = async (f: Parameters<CohortApplicationAdminService['list']>[1]) => (await appAdmin.list(cohortId, f)).items.map((i) => i.id).sort();
      expect(await ids({})).toEqual([a.id, b.id, c.id].sort());
      expect(await ids({ status: 'ACCEPTED' })).toEqual([c.id]);
      expect(await ids({ activityType: 'KOL' })).toEqual([b.id]);
      expect(await ids({ interestArea: 'BIZDEV' })).toEqual([b.id]);
      expect(await ids({ q: '50%_off' })).toEqual([a.id]); // "%" and "_" are not wildcards
      expect(await ids({ q: '%' })).toEqual([a.id]);
      expect(await ids({ q: 'bob_tele' })).toEqual([b.id]);
      expect(await ids({ q: 'CAROL_X' })).toEqual([c.id]);
      expect(await ids({ q: `kol_${tag}` })).toEqual([b.id]);
      expect(await ids({ q: `${c.userId}@example.test` })).toEqual([]); // email is google-... based
      const email = (await db.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [a.userId])).rows[0].email;
      expect(await ids({ q: email })).toEqual([a.id]);
      expect(await ids({ status: 'REJECTED' })).toEqual([]);
    });

    it('paginates with a stable order and exact total', async () => {
      const { cohortId } = await seed();
      const p1 = await appAdmin.list(cohortId, {}, 1, 2);
      const p2 = await appAdmin.list(cohortId, {}, 2, 2);
      expect(p1.total).toBe(3);
      expect(p1.items).toHaveLength(2);
      expect(p2.items).toHaveLength(1);
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(3);
      await expect(appAdmin.list('00000000-0000-4000-8000-000000000000', {})).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
    });

    it('review decisions can be changed; the audit trail keeps before/after; the note is replaced; accepting does not make the user a member', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const { id } = await apps.apply(cohortId, userId, base) as { id: string };
      const accepted = await appAdmin.review(id, 'ACCEPTED', 'good fit', adminId);
      expect(accepted).toMatchObject({ status: 'ACCEPTED', reviewNote: 'good fit', reviewedBy: adminId });
      const changed = await appAdmin.review(id, 'REJECTED', null, adminId);
      expect(changed).toMatchObject({ status: 'REJECTED', reviewNote: null });
      const trail = await db.query<{ action: string; before_data: any; after_data: any }>(
        `SELECT action, before_data, after_data FROM audit_log WHERE entity_id = $1 AND action LIKE 'COHORT_APPLICATION_%' AND before_data IS NOT NULL ORDER BY created_at, action`, [id]);
      expect(trail.rows.map((r) => [r.action, r.before_data.status, r.after_data.status]).sort()).toEqual([
        ['COHORT_APPLICATION_ACCEPTED', 'SUBMITTED', 'ACCEPTED'], ['COHORT_APPLICATION_REJECTED', 'ACCEPTED', 'REJECTED'],
      ]);
      await appAdmin.review(id, 'ACCEPTED', null, adminId);
      const member = await db.query<{ is_member: boolean }>(`SELECT is_member FROM "user" WHERE id = $1`, [userId]);
      expect(member.rows[0].is_member).toBe(false);
      await expect(appAdmin.review('00000000-0000-4000-8000-000000000000', 'ACCEPTED', null, adminId)).rejects.toMatchObject({ message: 'COHORT_APPLICATION_NOT_FOUND' });
    });

    it('CSV: BOM, escaped cells, formula-injection neutralized in every user-controlled column, filters respected, handles without @', async () => {
      const { cohortId, c } = await seed();
      const csv = await appAdmin.csv(cohortId, {});
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.slice(1).split('\r\n');
      expect(lines[0]).toBe(CSV_HEADER_LINE);
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`); // display_name
      expect(csv).toContain(`"'+cmd|calc"`); // review_note
      expect(csv).toContain('"line1\nline2 ""quoted"", and a comma"');
      expect(csv).toContain('"carol_x"');
      expect(csv).not.toMatch(/(^|,)"[=+\-@]/m); // no cell starts with a formula character
      const onlyAccepted = await appAdmin.csv(cohortId, { status: 'ACCEPTED' });
      expect(onlyAccepted.split('\r\n').filter(Boolean)).toHaveLength(2);
      expect(onlyAccepted).toContain(c.id);
      await expect(appAdmin.csv('00000000-0000-4000-8000-000000000000', {})).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
    });
  });

  describe('constraints (defense in depth below the API)', () => {
    it('the database itself refuses inconsistent rows', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const insert = (over: Record<string, unknown>) => {
        const v = { telegram: '@abcde', twitter: '@a', activity_type: 'DEVELOPER', other: null, areas: ['KOL'], interest_other: null, intro: 'hi', status: 'SUBMITTED', ...over };
        return db.query(
          `INSERT INTO cohort_application (cohort_id, user_id, display_name, telegram, twitter, web3_experience, activity_type, activity_type_other, interest_areas, interest_other, intro, status)
           VALUES ($1, $2, 'n', $3, $4, 'LT_1Y', $5, $6, $7::text[], $8, $9, $10)`,
          [cohortId, userId, v.telegram, v.twitter, v.activity_type, v.other, v.areas, v.interest_other, v.intro, v.status]);
      };
      await expect(insert({ telegram: 'abcde' })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ twitter: '@bad-handle' })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ activity_type: 'OTHER' })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ other: 'stray' })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ areas: [] })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ areas: ['STUDENT'] })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ areas: ['OTHER'] })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ intro: '   ' })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ intro: 'x'.repeat(1001) })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ status: 'PENDING' })).rejects.toMatchObject({ code: '23514' });
      await insert({});
      await expect(insert({})).rejects.toMatchObject({ code: '23505', constraint: 'uq_cohort_application_user' });
      await expect(db.query(`INSERT INTO cohort (name, created_by, opens_at, closes_at) VALUES ('w', $1, now(), now() - interval '1 hour')`, [adminId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('account withdrawal', () => {
    it('withdraws SUBMITTED applications, keeps every row, leaves decided ones as recorded', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db, { nickname: unique('leaver-') });
      const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [userId])).rows[0].nickname;
      const { id } = await apps.apply(cohortId, userId, base) as { id: string };

      // 같은 유저의 다른 기수에서 이미 합격한 지원서는 기록으로 남는다
      await admin.transition(cohortId, 'CLOSED', adminId);
      const older = await openCohort();
      await db.query(
        `INSERT INTO cohort_application (cohort_id, user_id, display_name, telegram, twitter, web3_experience, activity_type, interest_areas, intro, status)
         VALUES ($1, $2, 'n', '@abcde', '@a', 'LT_1Y', 'DEVELOPER', ARRAY['KOL'], 'hi', 'ACCEPTED')`, [older, userId]);

      await withdrawal.withdraw(userId, nickname);
      const rows = await db.query<{ id: string; status: string }>(`SELECT id, status FROM cohort_application WHERE user_id = $1 ORDER BY status`, [userId]);
      expect(rows.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'WITHDRAWN']);
      expect(rows.rows.find((r) => r.status === 'WITHDRAWN')!.id).toBe(id);
    });
  });
});

const CSV_HEADER_LINE = '"id","applied_at","status","display_name","nickname","email","telegram","twitter","web3_experience","activity_type","activity_type_other","interest_areas","interest_other","intro","review_note","reviewed_at"';

describeDb('notice event_date on a real database', () => {
  let db: DatabaseService;
  let admin: NoticeAdminService;
  let notices: NoticesService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    admin = new NoticeAdminService(db, new AuditService(db));
    notices = new NoticesService(db);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  it('stores a calendar date as YYYY-MM-DD text (no timezone shift), clears with null, and returns it on list/detail/admin list', async () => {
    const { id } = await admin.create(adminId, { title: unique('ev-'), body: 'b', category: 'EVENT', eventDate: '2026-03-01', publish: true });
    expect((await notices.detail(id)).event_date).toBe('2026-03-01');
    expect((await admin.list()).find((n: { id: string }) => n.id === id)).toMatchObject({ event_date: '2026-03-01' });
    await admin.update(id, { eventDate: '2026-12-31' }, adminId);
    expect((await notices.detail(id)).event_date).toBe('2026-12-31');
    await admin.update(id, { eventDate: null }, adminId);
    expect((await notices.detail(id)).event_date).toBeNull();
    await admin.update(id, { title: 'unrelated edit' }, adminId);
    await admin.update(id, { eventDate: '2026-05-05' }, adminId);
    await admin.update(id, { title: 'edit again' }, adminId);
    expect((await notices.detail(id)).event_date).toBe('2026-05-05'); // other edits leave it alone
  });

  it('sort=eventDate: event date desc, undated last, default order unchanged; a date that slipped past the DTO is rejected by Postgres (22008, which the error filter maps to INVALID_DATE)', async () => {
    const tag = unique('sortcat-');
    const mk = async (eventDate: string | null, publishedGapMs: number) => {
      const { id } = await admin.create(adminId, { title: `${tag}-${eventDate}`, body: 'b', category: 'EVENT', eventDate, publish: true });
      await db.query(`UPDATE notice SET published_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`, [id, String(publishedGapMs)]);
      return id;
    };
    const early = await mk('2026-01-01', 3000);
    const late = await mk('2026-09-09', 1000);
    const undatedNewest = await mk(null, 5000);
    const undatedOlder = await mk(null, 4000);
    const titles = (rows: Array<{ id: string }>) => rows.map((r) => r.id).filter((id) => [early, late, undatedNewest, undatedOlder].includes(id));

    const byEvent = await notices.list(1, 50, 'EVENT', 'eventDate');
    expect(titles(byEvent.items as Array<{ id: string }>)).toEqual([late, early, undatedNewest, undatedOlder]);
    const byPublished = await notices.list(1, 50, 'EVENT');
    expect(titles(byPublished.items as Array<{ id: string }>)).toEqual([undatedNewest, undatedOlder, early, late]);
    await expect(admin.create(adminId, { title: 'bad', body: 'b', category: 'EVENT', eventDate: '2026-02-30' })).rejects.toMatchObject({ code: '22008' });
  });
});
