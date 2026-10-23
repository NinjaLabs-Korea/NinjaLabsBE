import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import { AGENT_API_THROTTLER, AgentApiThrottlerGuard } from './agent-api-throttler.guard';
import { AgentApiController } from './agent-api.controller';
import { AgentApiGuard, AgentApiRequest } from './agent-api.guard';

jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describe('AgentApiThrottlerGuard', () => {
  const agentA = '11111111-1111-4111-8111-111111111111';
  const agentB = '22222222-2222-4222-8222-222222222222';

  async function setup(totalHits = 1, isBlocked = false) {
    const storage = {
      increment: jest.fn(async () => ({ totalHits, timeToExpire: 60, isBlocked, timeToBlockExpire: isBlocked ? 60 : 0 })),
    };
    const guard = new AgentApiThrottlerGuard([AGENT_API_THROTTLER], storage as unknown as ThrottlerStorage, new Reflector());
    await guard.onModuleInit();
    return { guard, storage };
  }

  function context(agentId: string | undefined, handler = 'apply', ip = '10.0.0.1', res = { header: jest.fn() }) {
    const req = { ip, headers: {}, agent: agentId ? { agentId } : undefined } as unknown as AgentApiRequest;
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ({ name: handler }),
      getClass: () => AgentApiController,
    } as unknown as ExecutionContext;
  }

  it('counts requests per agent id (not per IP or per route) with a 60/min budget', async () => {
    const { guard, storage } = await setup();
    await expect(guard.canActivate(context(agentA, 'apply', '10.0.0.1'))).resolves.toBe(true);
    await expect(guard.canActivate(context(agentA, 'submit', '10.0.0.2'))).resolves.toBe(true);
    await expect(guard.canActivate(context(agentB, 'apply', '10.0.0.1'))).resolves.toBe(true);
    const keys = storage.increment.mock.calls.map((call) => (call as unknown[])[0]);
    expect(keys[0]).toBe(`agent-api:agent:${agentA}`);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(`agent-api:agent:${agentB}`);
    expect((storage.increment.mock.calls[0] as unknown[]).slice(1, 4)).toEqual([60_000, 60, 60_000]);
  });

  it('throws 429 once the per-agent budget is exhausted', async () => {
    const { guard } = await setup(61, true);
    await expect(guard.canActivate(context(agentA))).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('emits the `-agent-api` suffixed headers documented in docs/agent-api.md (X-RateLimit-* when allowed, only Retry-After-agent-api on 429)', async () => {
    const allowed = { header: jest.fn() };
    await (await setup(5)).guard.canActivate(context(agentA, 'apply', '10.0.0.1', allowed));
    expect(allowed.header.mock.calls).toEqual([
      ['X-RateLimit-Limit-agent-api', 60],
      ['X-RateLimit-Remaining-agent-api', 55],
      ['X-RateLimit-Reset-agent-api', 60],
    ]);

    const blocked = { header: jest.fn() };
    await expect((await setup(61, true)).guard.canActivate(context(agentA, 'apply', '10.0.0.1', blocked))).rejects.toBeInstanceOf(ThrottlerException);
    expect(blocked.header.mock.calls).toEqual([['Retry-After-agent-api', 60]]);
  });

  it('fails closed with 401 when no agent principal is on the request (guard ran before AgentApiGuard)', async () => {
    const { guard, storage } = await setup();
    await expect(guard.canActivate(context(undefined))).rejects.toMatchObject({ message: 'MISSING_AGENT_API_KEY' });
    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('is bound on the controller after AgentApiGuard (Nest runs @UseGuards entries in declaration order)', () => {
    const guards = Reflect.getMetadata('__guards__', AgentApiController) as unknown[];
    expect(guards).toEqual([AgentApiGuard, AgentApiThrottlerGuard]);
  });
});
