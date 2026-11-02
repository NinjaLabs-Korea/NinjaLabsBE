import { Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { E2eApp, startApp, UUID } from './support/harness';
import { getInjectiveAddress } from './support/injective-sdk.stub';

describeDb('wallet replacement disabled by default over HTTP', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());
  it('fails closed for both authenticated endpoints without changing a wallet or challenge', async () => {
    const session = await e2e.login(), options = { token: session.accessToken };
    for (const [path, body] of [
      ['challenge', { currentAddress: Wallet.createRandom().address, newAddress: Wallet.createRandom().address }],
      ['verify', { challengeId: '11111111-1111-4111-8111-111111111111', currentSignature: 'a', newSignature: 'b' }],
    ] as const) {
      const response = await e2e.post(`/wallets/replacement/${path}`, body, options);
      expect(response.status).toBe(503);
      expect(response.body.message).toBe('WALLET_CHANGE_DISABLED');
    }
    expect((await e2e.db.query(`SELECT id FROM wallet_replacement_challenge WHERE user_id=$1`, [session.userId])).rowCount).toBe(0);
    expect((await e2e.get('/auth/me', options)).status).toBe(200);
  });

  it('still enqueues and mints a first-link parent while the replacement feature is disabled', async () => {
    const session = await e2e.login(), options = { token: session.accessToken }, signer = Wallet.createRandom();
    const challenge = await e2e.post('/wallets/challenge', { address: signer.address }, options);
    const wallet = await e2e.post('/wallets/verify', { address: signer.address, signature: await signer.signMessage(challenge.body.message) }, options);
    expect(wallet.status).toBe(201);
    const nft = (await e2e.db.query(`SELECT id,status FROM nft WHERE owner_user_id=$1 AND nft_type='NINJA_PARENT'`, [session.userId])).rows[0];
    expect(nft.status).toBe('PENDING');
    // Prioritize only this fixture. This uses the fake chain, never a real mint.
    await e2e.db.query(`UPDATE nft_job SET scheduled_at=now()-interval '100 years' WHERE nft_id=$1`, [nft.id]);
    const configured = jest.spyOn(e2e.chain, 'isConfigured').mockReturnValue(true);
    try {
      await e2e.app.get(NftJobWorker).poll();
      expect(e2e.chain.mints).toContainEqual({ tokenId: nft.id, owner: getInjectiveAddress(signer.address) });
      expect((await e2e.db.query(`SELECT status FROM nft WHERE id=$1`, [nft.id])).rows[0].status).toBe('MINTED');
      expect((await e2e.post('/wallets/replacement/challenge', { currentAddress: signer.address, newAddress: Wallet.createRandom().address }, options)).body.message).toBe('WALLET_CHANGE_DISABLED');
    } finally { configured.mockRestore(); }
  });
});

describeDb('wallet replacement over HTTP', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp({ WALLET_REPLACEMENT_ENABLED: 'true' }); });
  afterAll(async () => e2e?.close());

  it('requires two purpose-bound proofs, preserves the parent, refreshes auth/me and retries idempotently', async () => {
    const session = await e2e.login();
    const options = { token: session.accessToken };
    const old = Wallet.createRandom();
    const next = Wallet.createRandom();
    const connected = await e2e.post('/wallets/challenge', { address: old.address }, options);
    const wallet = await e2e.post('/wallets/verify', { address: old.address, signature: await old.signMessage(connected.body.message) }, options);
    const input = { currentAddress: old.address, newAddress: next.address };
    expect((await e2e.post('/wallets/replacement/challenge', input, options)).body.message).toBe('WALLET_CHANGE_BLOCKED_NFT_JOBS');
    // This is an HTTP/DB test, not a chain test: represent a completed mint before exercising replacement.
    await e2e.db.query(`UPDATE nft SET status = 'MINTED', token_id = 'existing-parent' WHERE owner_user_id = $1`, [session.userId]);
    await e2e.db.query(`UPDATE nft_job SET status = 'SUCCEEDED' WHERE nft_id IN (SELECT id FROM nft WHERE owner_user_id = $1)`, [session.userId]);
    const challenge = await e2e.post('/wallets/replacement/challenge', input, options);
    expect(challenge.status).toBe(201);
    expect(challenge.headers['cache-control']).toBe('no-store, private');
    expect(challenge.body).toMatchObject({ id: expect.stringMatching(UUID), currentAddress: old.address, newAddress: next.address, expiresAt: expect.any(String) });
    const proof = { challengeId: challenge.body.id, currentSignature: await old.signMessage(challenge.body.currentMessage), newSignature: await next.signMessage(challenge.body.newMessage) };
    const invalid = await e2e.post('/wallets/replacement/verify', { ...proof, currentSignature: await next.signMessage(challenge.body.currentMessage) }, options);
    expect(invalid.status).toBe(401);
    expect(invalid.body.message).toBe('INVALID_SIGNATURE');
    expect((await e2e.get('/wallets/me', options)).body.id).toBe(wallet.body.id);
    const switched = await e2e.post('/wallets/replacement/verify', proof, options);
    expect(switched.status).toBe(201);
    expect(switched.headers['cache-control']).toBe('no-store, private');
    expect(switched.body).toMatchObject({ address: getInjectiveAddress(next.address), verified_at: expect.any(String) });
    expect(switched.body.id).not.toBe(wallet.body.id);
    expect((await e2e.post('/wallets/replacement/verify', proof, options)).body).toEqual(switched.body);
    expect((await e2e.get('/auth/me', options)).body).toMatchObject({ wallet: { address: getInjectiveAddress(next.address) }, nft: { tokenId: 'existing-parent' } });
    expect((await e2e.db.query(`SELECT owner_wallet_id FROM nft WHERE owner_user_id = $1`, [session.userId])).rows).toEqual([{ owner_wallet_id: wallet.body.id }]);
  });

  it('guards authentication and validates UUID, proof size, missing proofs and overposting', async () => {
    expect((await e2e.post('/wallets/replacement/challenge', {})).status).toBe(401);
    expect((await e2e.post('/wallets/replacement/verify', {})).status).toBe(401);
    const session = await e2e.login();
    const options = { token: session.accessToken };
    for (const body of [{}, { currentAddress: 123, newAddress: 'a' }, { currentAddress: 'a', newAddress: 'b'.repeat(256) }]) {
      expect((await e2e.post('/wallets/replacement/challenge', body, options)).status).toBe(400);
    }
    for (const body of [
      {}, { challengeId: 'bad', currentSignature: 'a', newSignature: 'b' },
      { challengeId: '11111111-1111-4111-8111-111111111111', currentSignature: 'a', newSignature: 'b'.repeat(4097) },
      { challengeId: '11111111-1111-4111-8111-111111111111', currentSignature: 'a', newSignature: 'b', newAddress: 'overposted' },
    ]) expect((await e2e.post('/wallets/replacement/verify', body, options)).status).toBe(400);
  });

  it('rate limits replacement requests', async () => {
    const session = await e2e.login();
    const options = { token: session.accessToken, ip: '203.0.113.71' };
    for (let i = 0; i < 10; i++) expect((await e2e.post('/wallets/replacement/challenge', { currentAddress: 'bad', newAddress: 'bad' }, options)).status).toBe(400);
    expect((await e2e.post('/wallets/replacement/challenge', { currentAddress: 'bad', newAddress: 'bad' }, options)).status).toBe(429);
  });
});
