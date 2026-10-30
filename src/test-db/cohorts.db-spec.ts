import { copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { MIGRATIONS_DIR, applyMigrations, migrationFiles, sslOptions } from '../../scripts/migrate';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import { CohortAdminService } from '../cohorts/cohort-admin.service';
import { CohortApplicationAdminService } from '../cohorts/cohort-application-admin.service';
import { CohortApplicationsService } from '../cohorts/cohort-applications.service';
import { DEFAULT_COHORT_QUESTIONS } from '../cohorts/cohort-questions';
import { CohortsService } from '../cohorts/cohorts.service';
import { NoticeAdminService } from '../notices/notice-admin.service';
import { NoticesService } from '../notices/notices.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser, TEST_JWT_SECRET, testConfig, testSslEnv, unique } from './harness';

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

  describe('configurable questions (0021)', () => {
    const fixed = { displayName: '홍길동', telegram: '@ninja_kr', twitter: '@ninja_kr', intro: 'I want to build on Injective.' };
    const answers = (areas: string[] = ['DEVELOPER']) => [{ questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'interest_areas', choices: areas }];
    const rowOf = async (id: string) => (await db.query<Record<string, any>>(`SELECT web3_experience, activity_type, activity_type_other, interest_areas, interest_other, answers FROM cohort_application WHERE id = $1`, [id])).rows[0];

    it('create seeds the default questions; PUT replaces them in one transaction with an audit row, and GET /cohorts/current shows them', async () => {
      const { id, questions } = await admin.create(adminId, { name: unique('q-') });
      expect(questions).toEqual(DEFAULT_COHORT_QUESTIONS);
      await admin.transition(id, 'OPEN', adminId);
      expect((await cohorts.current())!.questions).toEqual(DEFAULT_COHORT_QUESTIONS);

      const out = await admin.putQuestions(id, adminId, [
        { id: 'web3_experience', type: 'SINGLE_CHOICE', label: { ko: 'Web3 경력', en: 'Web3 experience' }, required: true,
          options: [{ id: 'LT_1Y', label: { ko: '1년 미만' } }, { id: 'GT_3Y', label: { ko: '3년 이상' } }] },
        { type: 'LONG_TEXT', label: { ko: '지원 동기' }, required: false },
      ]);
      expect(out.questions.map((q) => q.id)).toEqual(['web3_experience', expect.stringMatching(/^q_[0-9a-f]{12}$/)]);
      expect((await cohorts.current())!.questions).toEqual(out.questions);
      expect((await admin.detail(id)).questions).toEqual(out.questions);
      const audit = await db.query<{ action: string; before_data: unknown; after_data: unknown }>(
        `SELECT action, before_data, after_data FROM audit_log WHERE entity_type = 'cohort' AND entity_id = $1 AND action = 'COHORT_QUESTIONS_UPDATED'`, [id]);
      expect(audit.rows).toEqual([{
        action: 'COHORT_QUESTIONS_UPDATED',
        before_data: { questionIds: ['web3_experience', 'interest_areas'] },
        after_data: { questionIds: ['web3_experience', out.questions[1].id] },
      }]);
      await expect(admin.putQuestions(id, adminId, [{ id: 'interest_areas', type: 'SHORT_TEXT', label: { ko: 'x' }, required: false }]))
        .rejects.toMatchObject({ message: 'COHORT_QUESTIONS_INVALID' }); // interest_areas was removed above
      await expect(admin.putQuestions('00000000-0000-4000-8000-000000000000', adminId, [])).rejects.toMatchObject({ message: 'COHORT_NOT_FOUND' });
      expect(await auditActions(db, 'cohort', id)).toContain('COHORT_QUESTIONS_UPDATED');
    });

    it('new-shape POST stores snapshot answers with NULL legacy columns; the response carries the answers and null legacy fields', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const out = await apps.apply(cohortId, userId, { ...fixed, answers: [...answers(['KOL', 'OTHER'])].map((a) => (a.questionId === 'interest_areas' ? { ...a, other: ' UX ' } : a)) }) as Record<string, any>;
      expect(out.answers.map((a: any) => [a.questionId, a.choices.map((c: any) => c.id), a.other])).toEqual([['web3_experience', ['Y1_3'], null], ['interest_areas', ['KOL', 'OTHER'], 'UX']]);
      expect(out).toMatchObject({ web3Experience: null, activityType: null, activityTypeOther: null, interestAreas: null, interestOther: null });
      expect(await rowOf(out.id)).toMatchObject({ web3_experience: null, activity_type: null, activity_type_other: null, interest_areas: null, interest_other: null });
      expect((await rowOf(out.id)).answers).toHaveLength(2);
      await expect(apps.apply(cohortId, await createUser(db), { ...fixed, answers: [answers()[0]] })).rejects.toMatchObject({ message: 'COHORT_ANSWERS_INVALID' });
      await expect(apps.apply(cohortId, await createUser(db), { ...fixed, answers: answers(['OTHER']) })).rejects.toMatchObject({ message: 'COHORT_OTHER_DETAIL_REQUIRED' });
      await expect(apps.apply(cohortId, await createUser(db), { ...fixed, answers: answers(), web3Experience: 'LT_1Y' })).rejects.toMatchObject({ message: 'COHORT_ANSWERS_INVALID' });
    });

    it('legacy-shape POST still works, writes legacy columns with empty answers and its response has synthesized answers', async () => {
      const cohortId = await openCohort();
      const out = await apps.apply(cohortId, await createUser(db), { ...fixed, ...{ web3Experience: 'LT_1Y', activityType: 'STUDENT', interestAreas: ['RESEARCHER'] } }) as Record<string, any>;
      expect(await rowOf(out.id)).toMatchObject({ web3_experience: 'LT_1Y', activity_type: 'STUDENT', interest_areas: ['RESEARCHER'], answers: [] });
      expect(out.answers.map((a: any) => a.questionId)).toEqual(['web3_experience', 'interest_areas', 'activity_type']);
      expect(out.answers[2].choices).toEqual([{ id: 'STUDENT', label: { ko: '학생', en: 'Student', zh: '学生' } }]);
      expect(out.web3Experience).toBe('LT_1Y');
      // a legacy PATCH on a legacy row works; answers on a legacy row convert it to the new shape; legacy fields on a new-shape row are refused
      expect(await apps.update(out.id, (await db.query<{ user_id: string }>(`SELECT user_id FROM cohort_application WHERE id = $1`, [out.id])).rows[0].user_id, { activityType: 'KOL' }))
        .toMatchObject({ activityType: 'KOL' });
    });

    it('PATCH: answers replace everything and null the legacy columns; a fixed-only PATCH keeps stored answers even after the form changed', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const { id } = await apps.apply(cohortId, userId, { ...fixed, answers: answers(['KOL']) }) as { id: string };
      await admin.putQuestions(cohortId, adminId, [{ type: 'SHORT_TEXT', label: { ko: '완전히 다른 질문' }, required: true }]);
      const kept = await apps.update(id, userId, { intro: 'edited intro' }) as Record<string, any>;
      expect(kept.intro).toBe('edited intro');
      expect(kept.answers.map((a: any) => a.questionId)).toEqual(['web3_experience', 'interest_areas']); // not re-checked against the new form
      await expect(apps.update(id, userId, { answers: answers() })).rejects.toMatchObject({ message: 'COHORT_ANSWERS_INVALID' }); // validated against the CURRENT questions
      await expect(apps.update(id, userId, { web3Experience: 'LT_1Y' })).rejects.toMatchObject({ message: 'COHORT_ANSWERS_INVALID' });
      const replaced = await apps.update(id, userId, { answers: [{ questionId: (await cohorts.current())!.questions[0].id, text: '새 답' }] }) as Record<string, any>;
      expect(replaced.answers).toHaveLength(1);
      expect(replaced.answers[0]).toMatchObject({ text: '새 답', choices: null });
    });

    it('editing a question label later does not change a stored answer', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const { id } = await apps.apply(cohortId, userId, { ...fixed, answers: answers(['KOL']) }) as { id: string };
      const current = (await cohorts.current())!.questions;
      await admin.putQuestions(cohortId, adminId, [
        { id: 'web3_experience', type: 'SINGLE_CHOICE', label: { ko: '이름이 바뀐 질문' }, required: true,
          options: [{ id: 'Y1_3', label: { ko: '바뀐 선택지' } }, { id: 'LT_1Y', label: { ko: '다른 선택지' } }] },
      ]);
      expect((await cohorts.current())!.questions[0].label.ko).toBe('이름이 바뀐 질문');
      const [mine] = await apps.mine(userId) as Record<string, any>[];
      expect(mine.answers[0].label).toEqual(current[0].label);
      expect(mine.answers[0].choices[0].label.ko).toBe('1~3년');
      expect(mine.answers.map((a: any) => a.questionId)).toEqual(['web3_experience', 'interest_areas']); // the removed question's answer is still there
      expect(id).toBe(mine.id);
    });

    it('filters: questionId+optionId match both legacy and new rows; the old aliases still work; a lone param is ignored', async () => {
      const cohortId = await openCohort();
      const legacy = await apps.apply(cohortId, await createUser(db), { ...fixed, web3Experience: 'GT_3Y', activityType: 'KOL', interestAreas: ['DEVELOPER', 'KOL'] }) as { id: string };
      const fresh = await apps.apply(cohortId, await createUser(db), { ...fixed, answers: answers(['DEVELOPER']) }) as { id: string };
      const other = await apps.apply(cohortId, await createUser(db), { ...fixed, answers: answers(['BIZDEV']) }) as { id: string };
      const ids = async (f: Parameters<CohortApplicationAdminService['list']>[1]) => (await appAdmin.list(cohortId, f)).items.map((i) => i.id).sort();
      expect(await ids({ questionId: 'interest_areas', optionId: 'DEVELOPER' })).toEqual([legacy.id, fresh.id].sort());
      expect(await ids({ interestArea: 'DEVELOPER' })).toEqual([legacy.id, fresh.id].sort());
      expect(await ids({ questionId: 'interest_areas', optionId: 'BIZDEV' })).toEqual([other.id]);
      expect(await ids({ questionId: 'web3_experience', optionId: 'GT_3Y' })).toEqual([legacy.id]);
      expect(await ids({ questionId: 'web3_experience', optionId: 'Y1_3' })).toEqual([fresh.id, other.id].sort());
      expect(await ids({ questionId: 'activity_type', optionId: 'KOL' })).toEqual([legacy.id]);
      expect(await ids({ activityType: 'KOL' })).toEqual([legacy.id]);
      expect(await ids({ questionId: 'interest_areas' })).toHaveLength(3);
      expect(await ids({ questionId: 'interest_areas', optionId: 'DEVELOPER', status: 'ACCEPTED' })).toEqual([]);
    });

    it('CSV: fixed 9 + current question labels + other_answers + review columns; legacy activity_type lands in other_answers', async () => {
      const cohortId = await openCohort();
      const legacy = await apps.apply(cohortId, await createUser(db), { ...fixed, web3Experience: 'LT_1Y', activityType: 'OTHER', activityTypeOther: '디자이너', interestAreas: ['KOL', 'OTHER'], interestOther: 'UX' }) as { id: string };
      const fresh = await apps.apply(cohortId, await createUser(db), { ...fixed, answers: answers(['DEVELOPER']) }) as { id: string };
      const csv = await appAdmin.csv(cohortId, {});
      const lines = csv.slice(1).split('\r\n').filter(Boolean);
      expect(lines[0]).toBe(CSV_HEADER_LINE);
      const cells = (id: string) => lines.find((l) => l.includes(id))!.split('","').map((c) => c.replace(/^"|"$/g, ''));
      const l = cells(legacy.id);
      expect(l.slice(9, 12)).toEqual(['1년 미만', 'KOL(인플루언서);기타 (UX)', '현재 활동 유형: 기타 (디자이너)']);
      const f = cells(fresh.id);
      expect(f.slice(9, 12)).toEqual(['1~3년', '개발자', '']);
      // a changed form changes the header, and answers to removed questions move to other_answers
      await admin.putQuestions(cohortId, adminId, [{ id: 'web3_experience', type: 'SINGLE_CHOICE', label: { ko: '경력' }, required: true,
        options: [{ id: 'LT_1Y', label: { ko: '1년 미만' } }, { id: 'Y1_3', label: { ko: '1~3년' } }] }]);
      const csv2 = (await appAdmin.csv(cohortId, {})).slice(1).split('\r\n').filter(Boolean);
      expect(csv2[0]).toBe('"id","applied_at","status","display_name","nickname","email","telegram","twitter","intro","경력","other_answers","review_note","reviewed_at"');
      expect(csv2.find((line) => line.includes(fresh.id))).toContain('"참여하고 싶은 분야: 개발자"');
    });

    it('CSV: free-text answers go through the same formula neutralization', async () => {
      const cohortId = await openCohort();
      const { questions } = await admin.putQuestions(cohortId, adminId, [{ type: 'LONG_TEXT', label: { ko: '=질문' }, required: true }]);
      await apps.apply(cohortId, await createUser(db), { ...fixed, answers: [{ questionId: questions[0].id, text: '=HYPERLINK("http://evil")' }] });
      const csv = await appAdmin.csv(cohortId, {});
      expect(csv).toContain(`"'=질문"`); // header
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`); // cell
    });

    it('the database refuses rows that mix the legacy columns and answers', async () => {
      const cohortId = await openCohort();
      const userId = await createUser(db);
      const insert = (cols: string, vals: string) => db.query(
        `INSERT INTO cohort_application (cohort_id, user_id, display_name, telegram, twitter, intro${cols}) VALUES ($1, $2, 'n', '@abcde', '@a', 'hi'${vals})`, [cohortId, userId]);
      // new-shape columns together with a legacy column
      await expect(insert(", web3_experience, answers", ", 'LT_1Y', '[{}]'::jsonb")).rejects.toMatchObject({ code: '23514', constraint: 'chk_cohort_application_answer_shape' });
      // legacy shape needs all three legacy columns
      await expect(insert(", web3_experience", ", 'LT_1Y'")).rejects.toMatchObject({ code: '23514', constraint: 'chk_cohort_application_answer_shape' });
      await expect(insert(", activity_type", ", 'KOL'")).rejects.toMatchObject({ code: '23514', constraint: 'chk_cohort_application_answer_shape' });
      await expect(insert(", answers", ", '{}'::jsonb")).rejects.toMatchObject({ code: '23514', constraint: 'chk_cohort_application_answers_array' });
      await expect(db.query(`UPDATE cohort SET questions = '{}'::jsonb WHERE id = $1`, [cohortId])).rejects.toMatchObject({ code: '23514', constraint: 'chk_cohort_questions_shape' });
      await expect(insert(", answers", ", '[]'::jsonb")).resolves.toBeDefined(); // new shape with no answers (all questions optional) is fine
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

const CSV_HEADER_LINE = '"id","applied_at","status","display_name","nickname","email","telegram","twitter","intro","Web3 경력","참여하고 싶은 분야","other_answers","review_note","reviewed_at"';

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


/** 0021 은 이미 있는 기수와 옛 형식 지원서를 건드리지 않고 기본 질문만 채워야 한다: 0020 까지만 적용한 별도 DB 에 옛 데이터를 넣고 0021 을 적용한다 */
describeDb('0021 migration on a database with legacy cohort data', () => {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const ssl = sslOptions(testSslEnv());
  const name = `ninjalabs_test_q21_${Date.now().toString(36)}_${unique().slice(0, 6)}`;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString(), ssl, max: 2 });
    db = createDb({ DATABASE_URL: url.toString() });
  });
  afterAll(async () => {
    await db.onApplicationShutdown();
    await pool.end();
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it('keeps legacy applications as they are and seeds the default questions into every existing cohort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ninjalabs-q21-'));
    for (const file of migrationFiles()) if (file < '0021') copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    await applyMigrations(pool, { dir });
    const adminId = await createUser(db, { isAdmin: true });
    const userId = await createUser(db);
    const draft = (await db.query<{ id: string }>(`INSERT INTO cohort (name, created_by, status) VALUES ('d', $1, 'DRAFT') RETURNING id`, [adminId])).rows[0].id;
    const closed = (await db.query<{ id: string }>(`INSERT INTO cohort (name, created_by, status) VALUES ('c', $1, 'CLOSED') RETURNING id`, [adminId])).rows[0].id;
    const app = (await db.query<{ id: string }>(
      `INSERT INTO cohort_application (cohort_id, user_id, display_name, telegram, twitter, web3_experience, activity_type, interest_areas, intro)
       VALUES ($1, $2, 'n', '@abcde', '@a', 'LT_1Y', 'KOL', ARRAY['KOL']::text[], 'hi') RETURNING id`, [closed, userId])).rows[0].id;

    const { applied } = await applyMigrations(pool);
    expect(applied).toEqual(['0021_cohort_questions.sql']);

    for (const id of [draft, closed]) {
      expect((await db.query<{ questions: unknown }>(`SELECT questions FROM cohort WHERE id = $1`, [id])).rows[0].questions).toEqual(DEFAULT_COHORT_QUESTIONS);
    }
    const row = (await db.query<Record<string, unknown>>(`SELECT web3_experience, activity_type, interest_areas, answers FROM cohort_application WHERE id = $1`, [app])).rows[0];
    expect(row).toEqual({ web3_experience: 'LT_1Y', activity_type: 'KOL', interest_areas: ['KOL'], answers: [] });
    // a cohort created after the migration without the app (raw SQL) starts empty; the app seeds defaults on create
    const raw = (await db.query<{ questions: unknown }>(`INSERT INTO cohort (name, created_by) VALUES ('raw', $1) RETURNING questions`, [adminId])).rows[0];
    expect(raw.questions).toEqual([]);
  });
});
