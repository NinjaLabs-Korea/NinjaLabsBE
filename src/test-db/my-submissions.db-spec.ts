import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';

describeDb('GET /submissions/me current-revision fields on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let submissions: SubmissionsService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    submissions = new SubmissionsService(db);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  async function openBounty(submissionMode: string) {
    const { id } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode, maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1000' },
    });
    const reward = await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [id]);
    await rewards.confirmDeposit(reward.rows[0].id, fakeTxHash(), '1000', adminId);
    await bounties.transition(id, 'OPEN', adminId);
    return id;
  }

  async function activeAgent(ownerId: string) {
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
       VALUES ($1, 'bot', $2, $3, 'ACTIVE', now()) RETURNING id`,
      [ownerId, unique('pk-'), `0x${unique()}`],
    );
    return agent.rows[0].id;
  }

  it('returns submission_url, repository_url and commit_sha of the latest revision for own and own-agent submissions only', async () => {
    const user = await createUser(db);
    const stranger = await createUser(db);
    await createPrimaryWallet(db, user);
    const agentId = await activeAgent(user);

    const direct = await openBounty('DIRECT');
    const mine = await submissions.submit(direct, user, {
      submissionUrl: 'https://x.test/v1', description: 'v1', repositoryUrl: 'https://github.com/x/y', commitSha: 'a'.repeat(40),
    });
    const agentBounty = await openBounty('AGENT');
    const viaAgent = await submissions.submitAsAgent(agentBounty, agentId, {
      submissionUrl: 'https://x.test/agent', description: 'by agent', repositoryUrl: 'https://github.com/x/agent', commitSha: 'b'.repeat(40),
    });
    const strangerBounty = await openBounty('DIRECT');
    const theirs = await submissions.submit(strangerBounty, stranger, {
      submissionUrl: 'https://x.test/other', description: 'other', repositoryUrl: 'https://github.com/x/other', commitSha: 'c'.repeat(40),
    });

    const rows = new Map((await submissions.mySubmissions(user)).map((r) => [r.id, r]));
    expect(rows.get(mine.id)).toMatchObject({ submission_url: 'https://x.test/v1', repository_url: 'https://github.com/x/y', commit_sha: 'a'.repeat(40) });
    expect(rows.get(viaAgent.id)).toMatchObject({ submission_url: 'https://x.test/agent', repository_url: 'https://github.com/x/agent', commit_sha: 'b'.repeat(40) });
    expect(rows.has(theirs.id)).toBe(false);

    // a resubmission replaces the current revision, and the endpoint shows the new one
    await submissions.submit(direct, user, { submissionUrl: 'https://x.test/v2', description: 'v2' });
    const after = (await submissions.mySubmissions(user)).find((r) => r.id === mine.id);
    expect(after).toMatchObject({ submission_url: 'https://x.test/v2', repository_url: null, commit_sha: null });
  });
});
