import { createHash } from 'crypto';

export const AGENT_API_KEY_MARKER = 'nj_';
export const AGENT_API_KEY_LOOKUP_PREFIX_LENGTH = 11;

export function agentApiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, AGENT_API_KEY_LOOKUP_PREFIX_LENGTH);
}

export function hashAgentApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
