import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JWT_VERIFY_OPTIONS } from './jwt-algorithm';

/**
 * access JWT 검증의 단일 출처 — Bearer 토큰 → SessionUser. AuthService.verifyAccessToken(→ AuthGuard)이 이 클래스에 위임한다.
 *
 * 여기를 고치는 경우:
 *   - access 토큰이 갖춰야 할 클레임 규칙(typ/sub/adm)을 바꿀 때 → AccessTokenVerifier.verify.
 *     발급 쪽 클레임 모양은 auth-sessions.ts(signAccessToken)에 있으니 **두 곳을 함께** 본다.
 *   - 레거시(typ 없는) 토큰 전환기를 끝낼 때 → 아래 TODO. legacyAccessTokenCutoff와 `legacy` 분기를 지운다.
 * 유저가 지금도 ACTIVE인지는 여기서 보지 않는다 — AuthService.assertActiveUser(user-status-cache.ts) 몫.
 */

export interface SessionUser {
  userId: string;
  isAdmin: boolean;
}

/**
 * `typ` 없는 레거시 access 토큰의 수용 기준 시각(ms). 이 시각 **이전에 발급된(iat)** 레거시 토큰만 받는다.
 *   - `LEGACY_ACCESS_TOKEN_CUTOFF`(ISO 8601) 미설정/빈 값 → **이 프로세스의 시작 시각** (`performance.timeOrigin`). 레거시 토큰은 typ을 넣기 전의
 *     구 코드만 발급하므로, 새 코드가 처음 배포될 때 이미 떠 있던 세션만 통과하고 access TTL(15분)이 지나면 저절로 닫힌다.
 *     이후 재시작에서도 기준은 "그 프로세스 시작"이지만 그때 남은 레거시 토큰은 이미 만료됐다.
 *   - 설정 → 그 시각 (예: 첫 배포 시각으로 고정). 파싱할 수 없으면 기동 거부.
 */
export function legacyAccessTokenCutoff(raw: string | undefined, processStart = performance.timeOrigin): number {
  const value = raw?.trim();
  if (!value) return Math.floor(processStart);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`LEGACY_ACCESS_TOKEN_CUTOFF must be an ISO 8601 timestamp, got "${value}"`);
  return parsed;
}

export class AccessTokenVerifier {
  /**
   * @param legacyCutoffMs typ 없는 레거시 access 토큰은 iat가 이 시각(ms) 이전일 때만 받는다 — legacyAccessTokenCutoff
   */
  constructor(
    private readonly jwt: JwtService,
    private readonly legacyCutoffMs: number,
  ) {}

  /**
   * access JWT 검증 — 서명·만료 외에 `typ === 'access'`와 문자열 `sub`를 요구한다 (state JWT 등 다른 용도 토큰 거부).
   *
   * 전환기 예외: 이 배포 이전에 발급된 access 토큰에는 `typ`이 없다. `typ`도 `p`(OAuth state 용도 클레임)도 없고 `sub`가 문자열이며
   * **`iat`가 기준 시각(legacyAccessTokenCutoff — 기본은 이 프로세스 시작 시각) 이전**인 토큰만 레거시 access 토큰으로 받는다 — 배포 직후
   * 로그인된 사용자가 전부 401을 맞지 않게 하되, 배포 뒤에 같은 시크릿으로 서명된 typ 없는 토큰은 받지 않는다. access TTL(15분)이 지나면 창은 저절로 닫힌다.
   * state 토큰(`p: 'gstate'`, `sub` 없음)은 어느 경로로도 통과하지 못한다.
   * TODO(remove after 2026-11-30): 레거시 분기(`legacy`)와 LEGACY_ACCESS_TOKEN_CUTOFF를 지우고 `typ === 'access'`만 남긴다.
   */
  async verify(token: string): Promise<SessionUser> {
    let payload: { sub?: unknown; adm?: unknown; typ?: unknown; p?: unknown; iat?: unknown };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown; adm?: unknown; typ?: unknown; p?: unknown; iat?: unknown }>(token, JWT_VERIFY_OPTIONS);
    } catch {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
    const legacy = payload.typ === undefined && payload.p === undefined
      && typeof payload.iat === 'number' && payload.iat * 1000 < this.legacyCutoffMs;
    if ((payload.typ !== 'access' && !legacy) || typeof payload.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
    return { userId: payload.sub, isAdmin: payload.adm === true };
  }
}
