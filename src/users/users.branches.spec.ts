import { ConflictException, Logger } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// 컨트롤러 import 사슬이 서명 검증 모듈(@injectivelabs/sdk-ts, ESM)까지 닿으므로 껍데기로 대체한다 (users.dto.spec와 동일)
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const userId = '11111111-1111-4111-8111-111111111111';

afterEach(() => jest.restoreAllMocks());

describe('UsersService.nicknameAvailable', () => {
  function setup(rowCount: number) {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount, rows: [] }));
    return { query, service: new UsersService({ query: withParamsCheck(query) } as unknown as DatabaseService) };
  }

  it('looks up the trimmed value case-insensitively among active users: free → true, taken → false', async () => {
    const free = setup(0);
    await expect(free.service.nicknameAvailable('  Ninja.Dev  ')).resolves.toBe(true);
    const [sql, params] = free.query.mock.calls[0];
    expect(params).toEqual(['Ninja.Dev']);
    expect(sql).toContain('lower(nickname) = lower($1)');
    expect(sql).toContain('deleted_at IS NULL');

    await expect(setup(1).service.nicknameAvailable('ninja')).resolves.toBe(false);
  });

  it.each([undefined, '', 'x', '.ninja', 'admin', ['a', 'b'], 42])('answers false for %p without querying', async (value) => {
    const { query, service } = setup(0);
    await expect(service.nicknameAvailable(value)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('UsersService.completeProfile / completeOnboarding', () => {
  it('updates nickname/bio/step 4 for the active user, replaces the tag set, and answers {ok:true} — all in one transaction', async () => {
    const txQuery = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [] }));
    const db = { query: jest.fn(), tx: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ query: withParamsCheck(txQuery) })) };
    const service = new UsersService(db as unknown as DatabaseService);
    await expect(service.completeProfile(userId, 'ninja', 'bio', ['DESIGN', 'DEV'])).resolves.toEqual({ ok: true });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    const calls = txQuery.mock.calls;
    expect(calls[0][0]).toContain('SET nickname = $2, bio = $3, onboarding_step = 4');
    expect(calls[0][0]).toContain('WHERE id = $1 AND deleted_at IS NULL');
    expect(calls[0][1]).toEqual([userId, 'ninja', 'bio']);
    // the old set is cleared before the new one is written (an edit that removes a tag really removes it)
    expect(calls[1]).toEqual(['DELETE FROM user_tag WHERE user_id = $1', [userId]]);
    expect(calls.slice(2).map(([, params]) => params)).toEqual([[userId, 'DESIGN'], [userId, 'DEV']]);
  });

  it('a non-unique database failure propagates unchanged (not reported as NICKNAME_TAKEN)', async () => {
    const failure = Object.assign(new Error('value too long'), { code: '22001' });
    const db = { tx: jest.fn(async () => { throw failure; }) };
    const error = await new UsersService(db as unknown as DatabaseService).completeProfile(userId, 'n', 'b', ['DEV']).catch((caught: unknown) => caught);
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ConflictException);
  });

  it('completeOnboarding only stamps a user that has not completed yet (the first completion time is kept)', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 0, rows: [] }));
    const service = new UsersService({ query: withParamsCheck(query) } as unknown as DatabaseService);
    await expect(service.completeOnboarding(userId)).resolves.toEqual({ ok: true });
    expect(query.mock.calls[0][0]).toContain('SET onboarding_completed_at = now()');
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1 AND onboarding_completed_at IS NULL');
    expect(query.mock.calls[0][1]).toEqual([userId]);
  });
});

describe('UsersService.publicProfile result shape', () => {
  it('spreads the user row and attaches completed bounties, agents and NFTs, each queried by the user id (not the nickname)', async () => {
    const user = { id: userId, nickname: 'Ninja', bio: 'b', is_member: true, member_role: 'CORE', created_at: 'then', tags: ['DEV'] };
    const bounty = { id: 'b1', title: 'T', payoutStatus: 'PAID' };
    const agent = { id: 'a1', name: 'bot', completed_bounties: [] };
    const nft = { id: 'n1', nft_type: 'NINJA_PARENT' };
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM "user" u')) return { rowCount: 1, rows: [user] };
      if (sql.includes('FROM bounty_submission s')) return { rowCount: 1, rows: [bounty] };
      if (sql.includes('FROM agent a')) return { rowCount: 1, rows: [agent] };
      if (sql.includes('FROM nft n')) return { rowCount: 1, rows: [nft] };
      throw new Error(`unexpected ${sql}`);
    });
    const service = new UsersService({ query: withParamsCheck(query) } as unknown as DatabaseService);
    await expect(service.publicProfile('ninja')).resolves.toEqual({ ...user, completedBounties: [bounty], agents: [agent], nfts: [nft] });
    expect(query.mock.calls[0][1]).toEqual(['ninja']);
    expect(query.mock.calls[0][0]).toContain("u.deleted_at IS NULL AND u.status = 'ACTIVE'");
    for (const [, params] of query.mock.calls.slice(1)) expect(params).toEqual([userId]);
    expect(query.mock.calls[2][0]).toContain('a.owner_user_id = $1 AND a.deleted_at IS NULL');
  });
});

describe('UsersController', () => {
  function setup() {
    const users = {
      nicknameAvailable: jest.fn(async () => true),
      completeProfile: jest.fn(async () => ({ ok: true })),
      completeOnboarding: jest.fn(async () => ({ ok: true })),
      publicProfile: jest.fn(async () => ({ id: userId })),
    };
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const req = { headers: { 'x-onboarding-trace-id': 't-1' }, user: { userId, isAdmin: false } } as never;
    return { users, controller: new UsersController(users as never), req, log, error };
  }

  it('check-nickname wraps the answer as {available}', async () => {
    const { users, controller } = setup();
    await expect(controller.checkNickname('ninja')).resolves.toEqual({ available: true });
    users.nicknameAvailable.mockResolvedValueOnce(false);
    await expect(controller.checkNickname(['a', 'b'])).resolves.toEqual({ available: false });
    expect(users.nicknameAvailable).toHaveBeenLastCalledWith(['a', 'b']);
  });

  it('profile save passes the session user (never a body id) and logs only lengths, not the nickname or bio', async () => {
    const { users, controller, req, log } = setup();
    await expect(controller.completeProfile(req, { nickname: 'secret-name', bio: 'private bio', tags: ['DEV', 'OTHER'] })).resolves.toEqual({ ok: true });
    expect(users.completeProfile).toHaveBeenCalledWith(userId, 'secret-name', 'private bio', ['DEV', 'OTHER']);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.join('\n')).not.toMatch(/secret-name|private bio/);
    expect(lines[0]).toContain('"nicknameLength":11');
    expect(lines[0]).toContain('"tagCount":2');
  });

  it('profile save / complete-onboarding / public profile failures are logged with the error code and rethrown unchanged', async () => {
    const { users, controller, req, error } = setup();
    const taken = new ConflictException('NICKNAME_TAKEN');
    users.completeProfile.mockRejectedValueOnce(taken);
    await expect(controller.completeProfile(req, { nickname: 'n', bio: 'b', tags: ['DEV'] })).rejects.toBe(taken);
    const down = new Error('db down');
    users.completeOnboarding.mockRejectedValueOnce(down);
    await expect(controller.completeOnboarding(req)).rejects.toBe(down);
    const missing = new Error('nope');
    users.publicProfile.mockRejectedValueOnce(missing);
    await expect(controller.publicProfile('ghost')).rejects.toBe(missing);
    const codes = error.mock.calls.map(([line]) => JSON.parse(String(line).replace('[onboarding] ', '')));
    expect(codes).toEqual([
      expect.objectContaining({ event: 'profile.save.failed', userId, errorCode: 'NICKNAME_TAKEN' }),
      expect.objectContaining({ event: 'onboarding.complete.failed', userId, errorCode: 'Error' }),
      expect.objectContaining({ event: 'public-profile.failed', nickname: 'ghost', errorCode: 'Error' }),
    ]);
  });

  it('complete-onboarding and public profile return the service result for the session user / the path nickname', async () => {
    const { users, controller, req } = setup();
    await expect(controller.completeOnboarding(req)).resolves.toEqual({ ok: true });
    expect(users.completeOnboarding).toHaveBeenCalledWith(userId);
    await expect(controller.publicProfile('Ninja')).resolves.toEqual({ id: userId });
    expect(users.publicProfile).toHaveBeenCalledWith('Ninja');
  });
});
