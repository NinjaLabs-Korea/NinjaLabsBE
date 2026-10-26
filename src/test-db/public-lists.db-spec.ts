import { DatabaseService } from '../common/database/database.service';
import { HighlightsService } from '../highlights/highlights.service';
import { MembersService } from '../members/members.service';
import { NoticesService } from '../notices/notices.service';
import { describeDb } from './describe-db';
import { createDb, createUser, unique } from './harness';

/**
 * Public list reads on a real database — the filters, ordering and JSON aggregation that a mock DB cannot check.
 * The test database is shared across suites, so every assertion is scoped to rows this suite created.
 */
describeDb('public lists (members, hall of fame, notices) on a real database', () => {
  let db: DatabaseService;
  let adminId: string;
  beforeAll(async () => {
    db = createDb();
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  describe('MembersService.list', () => {
    async function member(options: { order?: number | null; status?: string; deleted?: boolean; isMember?: boolean; role?: string; onboarded?: boolean } = {}) {
      const id = await createUser(db, { onboarded: options.onboarded });
      await db.query(
        `UPDATE "user" SET is_member = $2, member_role = $3, member_display_order = $4, status = $5,
                deleted_at = CASE WHEN $6::boolean THEN now() ELSE NULL END WHERE id = $1`,
        [id, options.isMember ?? true, options.role ?? 'DEV', options.order ?? null, options.status ?? 'ACTIVE', options.deleted ?? false],
      );
      return id;
    }

    it('lists only active, non-deleted members, ordered by display order with unordered members last', async () => {
      const second = await member({ order: 2 });
      const first = await member({ order: 1 });
      const unordered = await member({ order: null });
      const suspended = await member({ order: 0, status: 'SUSPENDED' });
      const withdrawn = await member({ order: 0, status: 'WITHDRAWN' });
      const deleted = await member({ order: 0, deleted: true });
      const notMember = await member({ order: 0, isMember: false });
      // unfinished onboarding: the public profile is 404, so a card would link to a dead page (and the FE sitemap would list it)
      const unfinished = await member({ order: 0, onboarded: false });

      const ids = (await new MembersService(db).list()).map((row) => (row as { id: string }).id);
      for (const hidden of [suspended, withdrawn, deleted, notMember, unfinished]) expect(ids).not.toContain(hidden);
      const mine = ids.filter((id) => [first, second, unordered].includes(id));
      expect(mine).toEqual([first, second, unordered]);
      expect(ids.indexOf(unordered)).toBeGreaterThan(ids.indexOf(second));
    });

    it('aggregates links in display order and returns [] (not [null]) for a member without links', async () => {
      const linked = await member({ order: 5 });
      const bare = await member({ order: 6 });
      await db.query(
        `INSERT INTO user_link (user_id, link_type, url, display_order) VALUES ($1, 'X', 'https://x.com/a', 2), ($1, 'GITHUB', 'https://github.com/a', 1)`,
        [linked],
      );
      const rows = (await new MembersService(db).list()) as Array<{ id: string; links: unknown; nickname: string }>;
      expect(rows.find((row) => row.id === linked)!.links).toEqual([
        { type: 'GITHUB', url: 'https://github.com/a' },
        { type: 'X', url: 'https://x.com/a' },
      ]);
      expect(rows.find((row) => row.id === bare)!.links).toEqual([]);
      // one row per member even with several links (GROUP BY u.id)
      expect(rows.filter((row) => row.id === linked)).toHaveLength(1);
      expect(Object.keys(rows.find((row) => row.id === linked)!).sort()).toEqual(
        ['bio', 'id', 'links', 'member_display_order', 'member_role', 'nickname'],
      );
    });
  });

  describe('HighlightsService.list', () => {
    it('returns published highlights only, by display order', async () => {
      const tag = unique('hl-');
      const insert = async (order: number, published: boolean) => (await db.query<{ id: string }>(
        `INSERT INTO platform_highlight (created_by, type, title, description, display_order, is_published, published_at)
         VALUES ($1, 'MILESTONE', $2, 'd', $3, $4, CASE WHEN $4 THEN now() END) RETURNING id`,
        [adminId, `${tag}-${order}`, order, published],
      )).rows[0].id;
      const late = await insert(900_002, true);
      const early = await insert(900_001, true);
      const draft = await insert(900_000, false);

      const rows = (await new HighlightsService(db).list()) as Array<{ id: string; title: string }>;
      const mine = rows.filter((row) => row.title.startsWith(tag)).map((row) => row.id);
      expect(mine).toEqual([early, late]);
      expect(mine).not.toContain(draft);
    });
  });

  describe('NoticesService.list', () => {
    it('pages a category with a correct total, disjoint pages and no drafts or deleted rows', async () => {
      // the category may hold rows from other suites — compare against the count before this test
      const before = (await new NoticesService(db).list(1, 50, 'INJECTIVE_ECOSYSTEM')).total;
      const tag = unique('n-');
      const published: string[] = [];
      for (let i = 0; i < 5; i++) {
        published.push((await db.query<{ id: string }>(
          `INSERT INTO notice (created_by, title, body, category, status, published_at)
           VALUES ($1, $2, 'b', 'INJECTIVE_ECOSYSTEM', 'PUBLISHED', '2030-01-01T00:00:00Z') RETURNING id`, // identical published_at: tie-break by created_at/id
          [adminId, `${tag}-${i}`],
        )).rows[0].id);
      }
      await db.query(`INSERT INTO notice (created_by, title, body, category) VALUES ($1, $2, 'b', 'INJECTIVE_ECOSYSTEM')`, [adminId, `${tag}-draft`]);
      await db.query(
        `INSERT INTO notice (created_by, title, body, category, status, published_at, deleted_at)
         VALUES ($1, $2, 'b', 'INJECTIVE_ECOSYSTEM', 'PUBLISHED', now(), now())`, [adminId, `${tag}-deleted`]);

      const notices = new NoticesService(db);
      const pageSize = 2;
      const total = (await notices.list(1, pageSize, 'INJECTIVE_ECOSYSTEM')).total;
      expect(total).toBe(before + 5);
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(total / pageSize); page++) {
        const result = await notices.list(page, pageSize, 'INJECTIVE_ECOSYSTEM');
        expect(result).toMatchObject({ page, pageSize, total });
        seen.push(...result.items.map((item) => (item as { id: string }).id));
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total); // no row on two pages
      expect(seen.filter((id) => published.includes(id)).sort()).toEqual([...published].sort());
      const titles = (await notices.list(1, 50, 'INJECTIVE_ECOSYSTEM')).items.map((item) => (item as { title: string }).title);
      expect(titles).not.toContain(`${tag}-draft`);
      expect(titles).not.toContain(`${tag}-deleted`);
    });

    it('an unknown category is an empty page, not an error (the CHECK set is not validated on read)', async () => {
      await expect(new NoticesService(db).list(1, 10, 'NOT_A_CATEGORY')).resolves.toEqual({ items: [], page: 1, pageSize: 10, total: 0 });
    });
  });
});
