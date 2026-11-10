import { All, Controller, GoneException } from '@nestjs/common';

/**
 * 종료된 라우트 - 옛 클라이언트가 404가 아니라 "종료됐다"는 명확한 응답을 받게 한다 (BE PR4, 정리 PR5에서 제거하면 404가 된다).
 *
 * - `ALL /agent-api/v1/*` -> 410 `AGENT_API_RETIRED`. 에이전트 기능은 구글 로그인 전용 전환(2026-11-11)으로 사라졌다.
 *   인증·본문 검사 없이 어떤 메서드든 같은 응답이다 (전역 IP throttler만 적용).
 */
@Controller()
export class RetiredRoutesController {
  @All(['agent-api/v1', 'agent-api/v1/*path'])
  agentApiRetired(): never {
    throw new GoneException('AGENT_API_RETIRED');
  }
}
