import { DatabaseService } from '../common/database/database.service';
import { HighlightsService, PaidTotal } from '../highlights/highlights.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, unique } from './harness';

describeDb('hall-of-fame stats paidTotals on a real database', () => {
  let db: DatabaseService;
  let userId: string;
  let walletId: string;

  beforeAll(async () => {
    db = createDb();
    userId = await createUser(db);
    walletId = (await createPrimaryWallet(db, userId)).id;
  });
  afterAll(async () => db.onApplicationShutdown());

  /** 매번 새 인스턴스 - 인메모리 캐시를 우회해 지금 DB 상태를 집계한다 */
  const freshStats = () => new HighlightsService(db).stats();

  async function bountyWithReward(symbol: string, tokenType: 'NATIVE' | 'CW20' = 'NATIVE'): Promise<{ bountyId: string; rewardId: string; submissionId: string }> {
    const bountyId = (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days') RETURNING id`, [userId, unique('hof-')])).rows[0].id;
    const rewardId = (await db.query<{ id: string }>(
      `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, token_contract_address, display_symbol, amount, custody_address)
       VALUES ($1, $2, $3, $4, $5, 1000000000000000000000000, 'inj1custody') RETURNING id`,
      [bountyId, tokenType, tokenType === 'NATIVE' ? 'inj' : null, tokenType === 'CW20' ? 'inj1cw20' : null, symbol])).rows[0].id;
    const submissionId = (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
       VALUES ($1, $2, 'https://example.test', 'd', 'APPROVED') RETURNING id`, [bountyId, userId])).rows[0].id;
    return { bountyId, rewardId, submissionId };
  }

  async function payout(rewardId: string, submissionId: string, amount: string, status: string) {
    await db.query(
      `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, payout_tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [rewardId, submissionId, walletId, amount, status, unique('idem-'), userId, status === 'PAID' ? fakeTxHash() : null],
    );
  }

  const totalsFor = (totals: PaidTotal[], symbol: string) => totals.filter((t) => t.symbol === symbol);

  it('sums PAID payouts per (symbol, token type) as exact base-unit strings and ignores other statuses and soft-deleted bounties', async () => {
    // 테스트 DB는 스위트끼리 공유되므로 이 테스트만 쓰는 고유 심볼로 격리한다
    const sym = unique('T').toUpperCase().slice(0, 10);
    const lower = sym.toLowerCase();

    const a = await bountyWithReward(sym);
    await payout(a.rewardId, a.submissionId, '123456789012345678901234567', 'PAID');
    await payout(a.rewardId, a.submissionId, '3', 'PAID');
    for (const status of ['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'FAILED', 'CANCELLED']) {
      await payout(a.rewardId, a.submissionId, '1000', status);
    }
    // 같은 심볼을 소문자로 저장한 다른 바운티도 같은 토큰으로 합친다
    const b = await bountyWithReward(lower);
    await payout(b.rewardId, b.submissionId, '7', 'PAID');
    // 같은 심볼이라도 토큰 유형이 다르면 별도 항목
    const c = await bountyWithReward(sym, 'CW20');
    await payout(c.rewardId, c.submissionId, '11', 'PAID');
    // 삭제(soft delete)된 바운티의 지급은 제외
    const d = await bountyWithReward(sym);
    await payout(d.rewardId, d.submissionId, '500', 'PAID');
    await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [d.bountyId]);

    expect(totalsFor((await freshStats()).paidTotals, sym)).toEqual([
      { symbol: sym, tokenType: 'CW20', decimals: null, amount: '11' },
      { symbol: sym, tokenType: 'NATIVE', decimals: null, amount: '123456789012345678901234577' },
    ]);
  });

  it('reports known token decimals (INJ 18) and is stable across the cache', async () => {
    const before = totalsFor((await freshStats()).paidTotals, 'INJ')[0]?.amount ?? '0';
    const e = await bountyWithReward('INJ');
    await payout(e.rewardId, e.submissionId, '1500000000000000000', 'PAID');

    const service = new HighlightsService(db);
    const [inj] = totalsFor((await service.stats()).paidTotals, 'INJ').filter((t) => t.tokenType === 'NATIVE');
    expect(inj).toMatchObject({ symbol: 'INJ', tokenType: 'NATIVE', decimals: 18 });
    expect(BigInt(inj.amount) - BigInt(before)).toBe(1500000000000000000n);

    // within the TTL the same instance serves the cached value even after another payout lands
    await payout(e.rewardId, e.submissionId, '1', 'PAID');
    expect(totalsFor((await service.stats()).paidTotals, 'INJ').find((t) => t.tokenType === 'NATIVE')!.amount).toBe(inj.amount);
  });

  it('counts sponsors that differ only by case or surrounding whitespace once', async () => {
    const before = (await freshStats()).sponsors;
    const name = unique('Sponsor-');
    for (const sponsor of [name, name.toUpperCase(), ` ${name.toLowerCase()} `]) {
      await db.query(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, status)
         VALUES ($1, $2, $3, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', 'COMPLETED')`,
        [userId, sponsor, unique('sp-')],
      );
    }
    expect((await freshStats()).sponsors - before).toBe(1);
  });
});
