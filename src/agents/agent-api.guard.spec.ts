import { ExecutionContext } from '@nestjs/common';
import { AgentApiGuard, AgentApiRequest } from './agent-api.guard';
import { AgentApiKeyService, AgentPrincipal } from './agent-api-key.service';

describe('AgentApiGuard', () => {
  const principal: AgentPrincipal = {
    agentId: '11111111-1111-4111-8111-111111111111',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    name: 'market-agent',
    walletAddress: '0x1111111111111111111111111111111111111111',
    apiKeyId: '33333333-3333-4333-8333-333333333333',
  };

  function context(authorization?: string) {
    const request = {
      headers: authorization ? { authorization } : {},
    } as AgentApiRequest;
    const executionContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    return { executionContext, request };
  }

  it('attaches the authenticated agent to the request', async () => {
    const apiKeys = { authenticate: jest.fn().mockResolvedValue(principal) };
    const guard = new AgentApiGuard(apiKeys as unknown as AgentApiKeyService);
    const { executionContext, request } = context('Bearer nj_1234567890abcdef');

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(apiKeys.authenticate).toHaveBeenCalledWith('nj_1234567890abcdef');
    expect(request.agent).toEqual(principal);
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer key with spaces'])(
    'rejects a missing or malformed authorization header: %s',
    async (authorization) => {
      const apiKeys = { authenticate: jest.fn() };
      const guard = new AgentApiGuard(apiKeys as unknown as AgentApiKeyService);
      const { executionContext } = context(authorization);

      await expect(guard.canActivate(executionContext)).rejects.toMatchObject({
        message: 'MISSING_AGENT_API_KEY',
      });
      expect(apiKeys.authenticate).not.toHaveBeenCalled();
    },
  );
});
