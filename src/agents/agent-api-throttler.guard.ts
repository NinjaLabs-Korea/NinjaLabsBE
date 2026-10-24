import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AgentApiRequest } from './agent-api.guard';

/** Agent API 키당 분당 요청 한도 — agents.module.ts의 throttlerModule()에 같은 이름으로 등록된다 */
export const AGENT_API_THROTTLER = { name: 'agent-api', ttl: 60_000, limit: 60 } as const;

/**
 * Agent API 전용 rate limit — 전역 IP 기준 한도(app.module.ts, 120/min)와 별도로 **에이전트(키) 기준** 60/min.
 * tracker가 `req.agent.agentId`이므로 반드시 AgentApiGuard **뒤에** 와야 한다 (`@UseGuards(AgentApiGuard, AgentApiThrottlerGuard)` —
 * Nest는 같은 데코레이터의 가드를 나열 순서대로 실행한다). 인증 전에 호출되면 fail-closed(401).
 * 키 하나의 모든 엔드포인트가 한 버킷을 쓰도록 generateKey에서 핸들러 이름을 뺀다.
 */
@Injectable()
export class AgentApiThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const agentId = (req as unknown as AgentApiRequest).agent?.agentId;
    if (!agentId) throw new UnauthorizedException('MISSING_AGENT_API_KEY');
    return `agent:${agentId}`;
  }

  protected generateKey(_context: ExecutionContext, tracker: string, name: string): string {
    return `${name}:${tracker}`;
  }
}
