import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig, unique } from './harness';

describeDb('lifecycle blockers for participants who left', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let lifecycle: BountyLifecycleService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    lifecycle = new BountyLifecycleService();
    bounties = new BountyAdminService(db, audit, lifecycle, new RewardTokenResolver(testConfig()));
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  it('an approved applicant who withdrew their account no longer blocks closing submissions', async () => {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await bounties.transition(bountyId, 'OPEN', adminId);
    const stayer = await createUser(db);
    const leaver = await createUser(db);
    for (const userId of [stayer, leaver]) {
      const application = await applications.apply(bountyId, userId, 'hi');
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    }
    const count = async () => {
      const r = await lifecycle.blockers(db, bountyId, { status: 'OPEN' });
      return r.blockerDetails.SUBMISSION_CLOSED.find((b) => b.code === 'UNSUBMITTED_PARTICIPANTS');
    };
    expect(await count()).toEqual({ code: 'UNSUBMITTED_PARTICIPANTS', count: 2 });

    await db.query(`UPDATE "user" SET status = 'WITHDRAWN', deleted_at = now() WHERE id = $1`, [leaver]);
    expect(await count()).toEqual({ code: 'UNSUBMITTED_PARTICIPANTS', count: 1 });
  });
  it('an approved applicant counts as submitted only once they themselves submitted (someone else\'s submission does not count)', async () => {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, maxWinners: 2,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await bounties.transition(bountyId, 'OPEN', adminId);
    const first = await createUser(db);
    const second = await createUser(db);
    for (const userId of [first, second]) {
      const application = await applications.apply(bountyId, userId, 'hi');
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    }
    const count = async () => {
      const r = await lifecycle.blockers(db, bountyId, { status: 'OPEN' });
      return r.blockerDetails.SUBMISSION_CLOSED.find((b) => b.code === 'UNSUBMITTED_PARTICIPANTS')?.count ?? 0;
    };
    expect(await count()).toBe(2);
    await submissions.submit(bountyId, first, { submissionUrl: 'https://example.test/a', description: 'd' });
    expect(await count()).toBe(1);
    await submissions.submit(bountyId, second, { submissionUrl: 'https://example.test/b', description: 'd' });
    expect(await count()).toBe(0);
  });

  it('a legacy agent-only application (no applicant user, pre BE PR4 data) is not counted as an unsubmitted participant', async () => {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await bounties.transition(bountyId, 'OPEN', adminId);
    const owner = await createUser(db);
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
       VALUES ($1, 'bot', $2, $3, 'ACTIVE', now()) RETURNING id`,
      [owner, unique('pk-'), `0x${unique()}`],
    );
    await db.query(
      `INSERT INTO bounty_application (bounty_id, agent_id, message, status) VALUES ($1, $2, 'legacy', 'APPROVED')`,
      [bountyId, agent.rows[0].id],
    );
    const r = await lifecycle.blockers(db, bountyId, { status: 'OPEN' });
    expect(r.blockerDetails.SUBMISSION_CLOSED.find((b) => b.code === 'UNSUBMITTED_PARTICIPANTS')).toBeUndefined();
  });
});
