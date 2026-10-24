import { HDNodeWallet, Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { AdminBountyForm, applyBody, saveAdminBountyBody, submitBody } from './support/fe-payloads';
import { DAY, E2eApp, isoIn, Session, startApp, txHash, UUID } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

function bountyForm(overrides: Partial<AdminBountyForm> = {}): AdminBountyForm {
  return {
    slug: '', title: `E2E bounty ${Date.now().toString(36)}`, sponsor: 'Injective Labs',
    description: 'Build a widget. '.repeat(30), requirements: '- a repo\n- a demo video', reviewProcess: 'Judged by the core team',
    tags: ['Dev'], intakeEnabled: true, maxWinners: 1, submissionMode: 'direct', coverImage: null,
    deadline: isoIn(14 * DAY), reward: { amount: 100, currency: 'INJ' }, ...overrides,
  };
}

// g. bounty lifecycle (admin + user + agent) · h. admin guard
describeDb('bounty lifecycle over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
  });
  afterAll(async () => e2e?.close());

  const asAdmin = { get token() { return admin.accessToken; } };
  async function createBounty(form: AdminBountyForm): Promise<string> {
    const res = await e2e.post('/admin/bounties', saveAdminBountyBody(form, true), { token: admin.accessToken });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.stringMatching(UUID) });
    return res.body.id;
  }
  async function adminRow(id: string) {
    const list = await e2e.get('/admin/bounties', asAdmin);
    return list.body.find((row: { id: string }) => row.id === id);
  }
  const transition = (id: string, to: string) => e2e.post(`/admin/bounties/${id}/transition`, { to }, asAdmin);

  it('reward bounty: create (FUNDING_PENDING) → confirm deposit → OPEN → apply → approve → submit → APPROVE → payout requested/approved/paid (child mint job) → COMPLETED', async () => {
    const builder = await e2e.login();
    const { nickname, walletAddress } = await e2e.onboard(builder);
    const form = bountyForm();
    const bountyId = await createBounty(form);

    // admin list row — exactly the fields createAdminApi().getAdminBounties reads
    const row = await adminRow(bountyId);
    expect(row).toMatchObject({
      id: bountyId, title: form.title, sponsor_name: 'Injective Labs', summary: form.description.slice(0, 240).trim(),
      requirements: form.requirements, evaluation_criteria: form.reviewProcess, category: 'DEV', status: 'FUNDING_PENDING',
      application_required: true, submission_mode: 'DIRECT', cover_image_url: null, application_deadline: null, max_winners: 1,
      rewards: [{ symbol: 'INJ', amount: '100000000000000000000', tokenType: 'NATIVE', tokenContractAddress: null, evmChainId: null }],
    });
    expect(new Date(row.submission_deadline).toISOString()).toBe(form.deadline);
    // not public before funding
    expect((await e2e.get(`/bounties/${bountyId}`)).status).toBe(404);

    const blocked = await transition(bountyId, 'OPEN');
    expect(blocked.status).toBe(400);
    expect(blocked.body).toEqual(badRequest(['Confirm all reward deposits before opening this bounty.']));

    const ops = await e2e.get(`/admin/bounties/${bountyId}/operations`, asAdmin);
    expect(ops.status).toBe(200);
    expect(Object.keys(ops.body).sort()).toEqual(['applications', 'bounty', 'lifecycle', 'payouts', 'rewards', 'submissions']);
    expect(ops.body.lifecycle.blockers.OPEN).toEqual(['Confirm all reward deposits before opening this bounty.']);
    const rewardId: string = ops.body.rewards[0].id;
    expect(ops.body.rewards[0]).toMatchObject({ status: 'DEPOSIT_PENDING', display_symbol: 'INJ', amount: '100000000000000000000', custody_address: 'inj1e2emultisig' });

    const short = await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: txHash(), depositedAmount: '1' }, asAdmin);
    expect(short.status).toBe(404);
    expect(short.body.message).toBe('REWARD_NOT_FOUND_OR_NOT_PENDING');
    const depositHash = txHash().toUpperCase().replace('0X', '0x');
    const deposit = await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: depositHash, depositedAmount: '100000000000000000000' }, asAdmin);
    expect(deposit.status).toBe(201);
    expect(deposit.body).toEqual({ id: rewardId, bounty_id: bountyId, status: 'FUNDED' });

    expect((await transition(bountyId, 'OPEN')).body).toEqual({ id: bountyId, status: 'OPEN' });
    const detail = await e2e.get(`/bounties/${bountyId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: bountyId, status: 'OPEN', rewards: [{ symbol: 'INJ', amount: '100000000000000000000', status: 'FUNDED' }], attachments: [] });

    // participant
    const applied = await e2e.post(`/bounties/${bountyId}/applications`, applyBody('I will build it', 'https://github.com/me'), { token: builder.accessToken });
    expect(applied.status).toBe(201);
    expect(applied.body).toEqual({ id: expect.stringMatching(UUID), status: 'PENDING', applied_at: expect.any(String) });
    expect((await e2e.post(`/bounties/${bountyId}/applications`, applyBody('again'), { token: builder.accessToken })).body)
      .toEqual({ statusCode: 409, error: 'Conflict', message: 'ALREADY_APPLIED' });
    const early = await e2e.post(`/bounties/${bountyId}/submissions`, submitBody({ submissionUrl: 'https://demo.example', description: 'x' }), { token: builder.accessToken });
    expect(early.body).toEqual({ statusCode: 403, error: 'Forbidden', message: 'APPLICATION_NOT_APPROVED' });

    const closeBlocked = await transition(bountyId, 'SUBMISSION_CLOSED');
    expect(closeBlocked.body).toEqual(badRequest(['Review 1 pending application(s) before closing submissions.']));

    const myApps = await e2e.get('/applications/me', { token: builder.accessToken });
    expect(myApps.body).toEqual([expect.objectContaining({ id: applied.body.id, status: 'PENDING', bounty_id: bountyId, bounty_title: form.title, category: 'DEV', agent: null })]);

    const approvedApp = await e2e.post(`/admin/applications/${applied.body.id}/review`, { decision: 'APPROVED', note: 'welcome' }, asAdmin);
    expect(approvedApp.body).toEqual({ id: applied.body.id, status: 'APPROVED' });

    const submitted = await e2e.post(`/bounties/${bountyId}/submissions`, submitBody({ submissionUrl: 'https://demo.example/v1', description: 'my work', repositoryUrl: '', commitSha: 'abc123' }), { token: builder.accessToken });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toEqual({ id: expect.stringMatching(UUID), revisionNo: 1, status: 'SUBMITTED' });
    const submissionId: string = submitted.body.id;
    const resubmitted = await e2e.post(`/bounties/${bountyId}/submissions`, submitBody({ submissionUrl: 'https://demo.example/v2', description: 'my work v2' }), { token: builder.accessToken });
    expect(resubmitted.body).toEqual({ id: submissionId, revisionNo: 2, status: 'RESUBMITTED' });

    expect((await transition(bountyId, 'COMPLETED')).body).toEqual(badRequest('INVALID_TRANSITION:OPEN->COMPLETED'));

    const stale = await e2e.post(`/admin/submissions/${submissionId}/review`, { decision: 'APPROVE', revisionNo: 1 }, asAdmin);
    expect(stale.body).toEqual(badRequest('SUBMISSION_REVISION_CHANGED'));
    const approve = await e2e.post(`/admin/submissions/${submissionId}/review`, { decision: 'APPROVE', revisionNo: 2, comment: 'great' }, asAdmin);
    expect(approve.body).toEqual({ id: submissionId, status: 'APPROVED' });

    const mySubs = await e2e.get('/submissions/me', { token: builder.accessToken });
    expect(mySubs.body).toEqual([expect.objectContaining({ id: submissionId, status: 'APPROVED', bounty_id: bountyId, agent: null, payment_status: 'PENDING', review_comment: 'great', current_revision_no: 2 })]);

    // payout
    const requested = await e2e.post('/admin/payouts', { rewardId, submissionId, amount: '100000000000000000000' }, asAdmin);
    expect(requested.status).toBe(201);
    expect(requested.body).toEqual({ id: expect.stringMatching(UUID), status: 'REQUESTED', requested_at: expect.any(String) });
    const payoutId: string = requested.body.id;
    expect((await e2e.post('/admin/payouts', { rewardId, submissionId, amount: '1' }, asAdmin)).body)
      .toEqual({ statusCode: 409, error: 'Conflict', message: 'PAYOUT_ALREADY_REQUESTED' });
    const closed = await transition(bountyId, 'SUBMISSION_CLOSED');
    expect(closed.body).toEqual({ id: bountyId, status: 'SUBMISSION_CLOSED' });
    expect((await transition(bountyId, 'IN_REVIEW')).body).toEqual({ id: bountyId, status: 'IN_REVIEW' });
    expect((await transition(bountyId, 'COMPLETED')).body)
      .toEqual(badRequest(['Record completed payments for all approved winners and finish every pending payout.']));

    expect((await e2e.post(`/admin/payouts/${payoutId}/approve`, undefined, asAdmin)).body).toEqual({ id: payoutId, status: 'APPROVED' });
    expect((await e2e.post(`/admin/payouts/${payoutId}/paid`, { txHash: 'not-a-hash' }, asAdmin)).body).toEqual(badRequest('INVALID_TX_HASH'));
    const payoutHash = txHash().toUpperCase().replace('0X', '0x');
    const paid = await e2e.post(`/admin/payouts/${payoutId}/paid`, { txHash: payoutHash }, asAdmin);
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ id: payoutId, status: 'PAID', payout_tx_hash: payoutHash.toLowerCase() });
    const opsAfter = await e2e.get(`/admin/bounties/${bountyId}/operations`, asAdmin);
    expect(opsAfter.body.payouts).toEqual([expect.objectContaining({ id: payoutId, status: 'PAID', payout_tx_hash: payoutHash.toLowerCase(), recipient_address: walletAddress, display_symbol: 'INJ' })]);
    expect(opsAfter.body.rewards[0].status).toBe('PAID');

    const child = await e2e.db.query<{ job_type: string; idempotency_key: string; status: string; parent: boolean }>(
      `SELECT j.job_type, j.idempotency_key, j.status, n.parent_nft_id IS NOT NULL AS parent
         FROM nft n JOIN nft_job j ON j.nft_id = n.id
        WHERE n.submission_id = $1 AND n.nft_type = 'BOUNTY_COMPLETION_CHILD'`, [submissionId]);
    expect(child.rows).toEqual([{ job_type: 'MINT_CHILD', idempotency_key: `mint-child:${submissionId}`, status: 'PENDING', parent: true }]);

    expect((await transition(bountyId, 'COMPLETED')).body).toEqual({ id: bountyId, status: 'COMPLETED' });
    expect((await e2e.get('/submissions/me', { token: builder.accessToken })).body[0].payment_status).toBe('PAID');

    const profile = await e2e.get(`/users/${encodeURIComponent(nickname)}`);
    expect(profile.status).toBe(200);
    expect(profile.body.completedBounties).toEqual([{
      id: bountyId, title: form.title, category: 'DEV', completed_at: expect.any(String),
      rewards: [{ amount: '100000000000000000000', symbol: 'INJ' }],
      postedRewards: [{ amount: '100000000000000000000', symbol: 'INJ' }], payoutStatus: 'PAID',
    }]);
    expect(profile.body.nfts.map((n: { nft_type: string }) => n.nft_type).sort()).toEqual(['BOUNTY_COMPLETION_CHILD', 'NINJA_PARENT']);

    const audit = await e2e.get(`/admin/audit-logs?entityType=bounty&entityId=${bountyId}`, asAdmin);
    expect(audit.body.items.map((i: { action: string }) => i.action).sort())
      .toEqual(['BOUNTY_COMPLETED', 'BOUNTY_CREATED', 'BOUNTY_IN_REVIEW', 'BOUNTY_OPEN', 'BOUNTY_SUBMISSION_CLOSED']);
  });

  it('a deposit tx hash is never accepted as a payout tx hash (and vice versa) → 409 TX_HASH_ALREADY_USED', async () => {
    const builder = await e2e.login();
    await e2e.onboard(builder);
    const id = await createBounty(bountyForm({ intakeEnabled: false, reward: { amount: 1, currency: 'INJ' } }));
    const rewardId: string = (await e2e.get(`/admin/bounties/${id}/operations`, asAdmin)).body.rewards[0].id;
    const depositHash = txHash();
    expect((await e2e.post(`/admin/rewards/${rewardId}/confirm-deposit`, { txHash: depositHash, depositedAmount: '1000000000000000000' }, asAdmin)).status).toBe(201);
    expect((await transition(id, 'OPEN')).body.status).toBe('OPEN');
    const sub = await e2e.post(`/bounties/${id}/submissions`, submitBody({ submissionUrl: 'https://demo.example/h', description: 'h' }), { token: builder.accessToken });
    await e2e.post(`/admin/submissions/${sub.body.id}/review`, { decision: 'APPROVE' }, asAdmin);
    const payout = await e2e.post('/admin/payouts', { rewardId, submissionId: sub.body.id, amount: '1000000000000000000' }, asAdmin);
    await e2e.post(`/admin/payouts/${payout.body.id}/approve`, undefined, asAdmin);

    // the sponsor's deposit (sponsor → multisig) cannot also be the winner's payout (multisig → winner)
    const reused = await e2e.post(`/admin/payouts/${payout.body.id}/paid`, { txHash: depositHash.toUpperCase().replace('0X', '0x') }, asAdmin);
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual({ statusCode: 409, error: 'Conflict', message: 'TX_HASH_ALREADY_USED' });
    const payoutHash = txHash();
    expect((await e2e.post(`/admin/payouts/${payout.body.id}/paid`, { txHash: payoutHash }, asAdmin)).status).toBe(201);

    // …and a recorded payout hash cannot be confirmed as another bounty's deposit
    const other = await createBounty(bountyForm({ reward: { amount: 1, currency: 'INJ' } }));
    const otherReward: string = (await e2e.get(`/admin/bounties/${other}/operations`, asAdmin)).body.rewards[0].id;
    const asDeposit = await e2e.post(`/admin/rewards/${otherReward}/confirm-deposit`, { txHash: payoutHash, depositedAmount: '1000000000000000000' }, asAdmin);
    expect(asDeposit.status).toBe(409);
    expect(asDeposit.body.message).toBe('TX_HASH_ALREADY_USED');
  });

  it('DELETE /admin/bounties/:id hides the bounty and records BOUNTY_DELETED (same transaction); a second delete is 404 with no extra audit row', async () => {
    const id = await createBounty(bountyForm({ reward: { amount: 0, currency: 'INJ' } }));
    expect((await e2e.delete(`/admin/bounties/${id}`, asAdmin)).body).toEqual({ id });
    expect((await e2e.delete(`/admin/bounties/${id}`, asAdmin)).status).toBe(404);
    const audit = await e2e.get(`/admin/audit-logs?entityType=bounty&entityId=${id}`, asAdmin);
    expect(audit.body.items.map((i: { action: string }) => i.action).filter((a: string) => a === 'BOUNTY_DELETED')).toEqual(['BOUNTY_DELETED']);
  });

  it('USDC reward from the FE (ERC20 without contract) is pinned to the configured Injective EVM contract', async () => {
    const id = await createBounty(bountyForm({ reward: { amount: 250.5, currency: 'USDC' } }));
    const row = await adminRow(id);
    expect(row.rewards).toEqual([{ symbol: 'USDC', amount: '250500000', tokenType: 'ERC20', tokenContractAddress: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', evmChainId: 1439 }]);
  });

  it('DEADLINE_IN_PAST only when the deadline actually changes (the FE resends the stored one, minute-truncated by datetime-local)', async () => {
    const id = await createBounty(bountyForm({ reward: { amount: 0, currency: 'INJ' } }));
    expect((await adminRow(id)).status).toBe('DRAFT');
    // time passes: the stored deadline is now in the past (Postgres clock moved via the row, seconds kept)
    await e2e.db.query(`UPDATE bounty SET submission_deadline = date_trunc('second', now()) - interval '2 days' + interval '37 seconds' WHERE id = $1`, [id]);
    const stored = new Date((await adminRow(id)).submission_deadline);
    const truncated = new Date(Math.floor(stored.getTime() / 60_000) * 60_000).toISOString();
    const form = bountyForm({ slug: id, title: 'Edited title', deadline: truncated, maxWinners: 1 });

    const unchanged = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody(form, false), asAdmin);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toEqual({ id, status: 'DRAFT' });
    expect((await adminRow(id)).title).toBe('Edited title');

    const moved = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody({ ...form, deadline: isoIn(-DAY) }, false), asAdmin);
    expect(moved.body).toEqual(badRequest('DEADLINE_IN_PAST'));
    expect((await transition(id, 'OPEN')).body).toEqual(badRequest(['Extend the submission deadline before opening this bounty.']));
    expect((await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody({ ...form, deadline: isoIn(7 * DAY) }, false), asAdmin)).status).toBe(200);
    expect((await transition(id, 'OPEN')).body).toEqual({ id, status: 'OPEN' });
  });

  it('MAX_WINNERS_BELOW_APPROVED when lowering maxWinners under the approved count; MAX_WINNERS_REACHED on an extra approval', async () => {
    const id = await createBounty(bountyForm({ intakeEnabled: false, reward: { amount: 0, currency: 'INJ' } }));
    const form = bountyForm({ slug: id, intakeEnabled: false, maxWinners: 2 });
    expect((await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody(form, false), asAdmin)).status).toBe(200);
    expect((await transition(id, 'OPEN')).body.status).toBe('OPEN');

    const submissions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const user = await e2e.login();
      const res = await e2e.post(`/bounties/${id}/submissions`, submitBody({ submissionUrl: `https://demo.example/${i}`, description: `entry ${i}` }), { token: user.accessToken });
      expect(res.status).toBe(201);
      submissions.push(res.body.id);
    }
    for (const sid of submissions.slice(0, 2)) {
      expect((await e2e.post(`/admin/submissions/${sid}/review`, { decision: 'APPROVE' }, asAdmin)).body.status).toBe('APPROVED');
    }
    expect((await e2e.post(`/admin/submissions/${submissions[2]}/review`, { decision: 'APPROVE' }, asAdmin)).body).toEqual(badRequest('MAX_WINNERS_REACHED'));
    const lowered = await e2e.patch(`/admin/bounties/${id}`, saveAdminBountyBody({ ...form, maxWinners: 1 }, false), asAdmin);
    expect(lowered.body).toEqual(badRequest('MAX_WINNERS_BELOW_APPROVED'));
    expect((await e2e.post(`/admin/submissions/${submissions[2]}/review`, { decision: 'REQUEST_REVISION' }, asAdmin)).body).toEqual(badRequest('REVISION_COMMENT_REQUIRED'));
  });

  describe('agent-mode bounty', () => {
    async function registerAgent(owner: Session, name: string, signer: HDNodeWallet = Wallet.createRandom()) {
      // FE AgentRegisterForm: { name, description? , walletAddress }
      const registered = await e2e.post('/agents', { name, walletAddress: signer.address }, { token: owner.accessToken });
      expect(registered.status).toBe(201);
      expect(registered.body).toEqual({ agentId: expect.stringMatching(UUID), status: 'PENDING_VERIFICATION', verificationMessage: expect.stringContaining(registered.body.agentId) });
      const verified = await e2e.post(`/agents/${registered.body.agentId}/verify`, { signature: await signer.signMessage(registered.body.verificationMessage) }, { token: owner.accessToken });
      expect(verified.status).toBe(201);
      expect(verified.body).toEqual({ agentId: registered.body.agentId, status: 'ACTIVE', apiKey: expect.stringMatching(/^nj_[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
      e2e.trackTokens(verified.body);
      return { agentId: registered.body.agentId as string, apiKey: verified.body.apiKey as string };
    }

    it('agents apply/submit with their key via /agent-api/v1; the owner sees those rows with `agent`, can withdraw them, and rotate/revoke keys', async () => {
      const owner = await e2e.login();
      await e2e.onboard(owner);
      const id = await createBounty(bountyForm({ submissionMode: 'agent', reward: { amount: 0, currency: 'INJ' } }));
      expect((await transition(id, 'OPEN')).body.status).toBe('OPEN');
      const a = await registerAgent(owner, 'alpha-bot');
      const b = await registerAgent(owner, 'beta-bot');

      const human = await e2e.post(`/bounties/${id}/applications`, applyBody('me'), { token: owner.accessToken });
      expect(human.body).toEqual(badRequest('AGENT_SUBMISSION_REQUIRED'));

      const appA = await e2e.post(`/agent-api/v1/bounties/${id}/applications`, { message: 'alpha applies' }, { token: a.apiKey });
      expect(appA.status).toBe(201);
      const appB = await e2e.post(`/agent-api/v1/bounties/${id}/applications`, { message: 'beta applies', portfolioUrl: 'https://beta.example' }, { token: b.apiKey });
      expect(appB.status).toBe(201);

      const mine = await e2e.get('/applications/me', { token: owner.accessToken });
      expect(mine.body.map((r: { agent: unknown }) => r.agent)).toEqual(expect.arrayContaining([{ id: a.agentId, name: 'alpha-bot' }, { id: b.agentId, name: 'beta-bot' }]));

      // the owner withdraws an agent's application
      expect((await e2e.post(`/applications/${appA.body.id}/withdraw`, undefined, { token: owner.accessToken })).body).toEqual({ id: appA.body.id, status: 'WITHDRAWN' });
      const stranger = await e2e.login();
      expect((await e2e.post(`/applications/${appB.body.id}/withdraw`, undefined, { token: stranger.accessToken })).status).toBe(404);

      expect((await e2e.post(`/admin/applications/${appB.body.id}/review`, { decision: 'APPROVED' }, asAdmin)).body.status).toBe('APPROVED');
      const sub = await e2e.post(`/agent-api/v1/bounties/${id}/submissions`, { submissionUrl: 'https://beta.example/out', description: 'beta result', commitSha: 'deadbeef' }, { token: b.apiKey });
      expect(sub.status).toBe(201);
      expect(sub.body).toEqual({ id: expect.stringMatching(UUID), revisionNo: 1, status: 'SUBMITTED' });
      const subs = await e2e.get('/submissions/me', { token: owner.accessToken });
      expect(subs.body).toEqual([expect.objectContaining({ id: sub.body.id, bounty_id: id, agent: { id: b.agentId, name: 'beta-bot' }, payment_status: 'NONE' })]);

      const agents = await e2e.get('/agents/me', { token: owner.accessToken });
      expect(agents.body).toHaveLength(2);
      expect(Object.keys(agents.body[0]).sort()).toEqual(
        ['completed_bounties', 'created_at', 'description', 'id', 'key_expires_at', 'key_prefix', 'key_status', 'name', 'status', 'verified_at', 'wallet_address'].sort());

      const rotated = await e2e.post(`/agents/${b.agentId}/keys/rotate`, undefined, { token: owner.accessToken });
      expect(rotated.status).toBe(201);
      expect(rotated.body).toEqual({ agentId: b.agentId, apiKey: expect.stringMatching(/^nj_/), expiresAt: expect.any(String) });
      e2e.trackTokens(rotated.body);
      expect((await e2e.get('/agent-api/v1/me', { token: b.apiKey })).status).toBe(401);
      expect((await e2e.get('/agent-api/v1/me', { token: rotated.body.apiKey })).status).toBe(200);

      expect((await e2e.post(`/agents/${b.agentId}/revoke`, undefined, { token: owner.accessToken })).body).toEqual({ agentId: b.agentId, status: 'REVOKED' });
      expect((await e2e.get('/agent-api/v1/me', { token: rotated.body.apiKey })).status).toBe(401);
      expect((await e2e.post(`/agents/${b.agentId}/keys/rotate`, undefined, { token: stranger.accessToken })).status).toBe(404);
    });
  });

  it('an agent whose owner is suspended or deleted can no longer use its API key (401 INVALID_AGENT_API_KEY)', async () => {
    const owner = await e2e.login();
    const signer = Wallet.createRandom();
    const registered = await e2e.post('/agents', { name: 'orphan-bot', walletAddress: signer.address }, { token: owner.accessToken });
    const verified = await e2e.post(`/agents/${registered.body.agentId}/verify`, { signature: await signer.signMessage(registered.body.verificationMessage) }, { token: owner.accessToken });
    e2e.trackTokens(verified.body);
    expect((await e2e.get('/agent-api/v1/me', { token: verified.body.apiKey })).status).toBe(200);

    // the owner's own refresh is refused once suspended (auth.service refresh); their agents must stop too
    await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [owner.userId]);
    const suspended = await e2e.get('/agent-api/v1/me', { token: verified.body.apiKey });
    expect(suspended.status).toBe(401);
    expect(suspended.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'INVALID_AGENT_API_KEY' });

    await e2e.db.query(`UPDATE "user" SET status = 'ACTIVE' WHERE id = $1`, [owner.userId]);
    expect((await e2e.get('/agent-api/v1/me', { token: verified.body.apiKey })).status).toBe(200);
    await e2e.db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [owner.userId]);
    expect((await e2e.get('/agent-api/v1/me', { token: verified.body.apiKey })).status).toBe(401);
  });

  it.todo('re-applying after withdrawing an application — product decision: uq_application_user/uq_application_agent (0004) keep the WITHDRAWN row, so POST /bounties/:id/applications answers 409 ALREADY_APPLIED forever; decide whether withdrawal is final or the row should be reopened');

  describe('h. admin guard', () => {
    it('a non-admin gets 403 ADMIN_ONLY on every /admin route; no token is 401', async () => {
      const user = await e2e.login();
      for (const [method, path] of [['GET', '/admin/bounties'], ['GET', '/admin/users'], ['GET', '/admin/notices'], ['GET', '/admin/audit-logs'], ['POST', '/admin/payouts']] as const) {
        const res = await e2e.request(method, path, { token: user.accessToken, json: method === 'POST' ? {} : undefined });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ statusCode: 403, error: 'Forbidden', message: 'ADMIN_ONLY' });
      }
      expect((await e2e.get('/admin/bounties')).status).toBe(401);
    });

    it('an admin un-flagged (is_admin=false) mid-session is refused on the very next request, before the token expires', async () => {
      const temp = await e2e.loginAdmin();
      expect((await e2e.get('/admin/bounties', { token: temp.accessToken })).status).toBe(200);
      await e2e.db.query(`UPDATE "user" SET is_admin = false WHERE id = $1`, [temp.userId]);
      const res = await e2e.get('/admin/bounties', { token: temp.accessToken });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('ADMIN_ONLY');
      // and a suspended admin likewise
      const other = await e2e.loginAdmin();
      await e2e.db.query(`UPDATE "user" SET status = 'SUSPENDED' WHERE id = $1`, [other.userId]);
      expect((await e2e.get('/admin/bounties', { token: other.accessToken })).status).toBe(403);
    });
  });
});
