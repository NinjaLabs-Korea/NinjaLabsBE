import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { bearerTokenOf } from '../common/http/bearer-token';
import { AgentApiKeyService, AgentPrincipal } from './agent-api-key.service';

export type AgentApiRequest = Request & { agent?: AgentPrincipal };

@Injectable()
export class AgentApiGuard implements CanActivate {
  constructor(private readonly apiKeys: AgentApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentApiRequest>();
    const key = bearerTokenOf(req.headers.authorization);
    if (!key) throw new UnauthorizedException('MISSING_AGENT_API_KEY');

    req.agent = await this.apiKeys.authenticate(key);
    return true;
  }
}
