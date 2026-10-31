import { Logger } from '@nestjs/common';

/**
 * 오리진 허용 목록 - CORS_ORIGINS / AUTH_ALLOWED_REDIRECT_ORIGINS 공용 매처.
 *
 * 항목은 콤마 구분이며 앞뒤 공백은 무시한다. 정확한 오리진 외에, 호스트 레이블 하나에 `*` 한 개를
 * 허용한다 (예: `https://ninjalabsfe-*-<team-slug>.vercel.app` → Vercel preview 배포). 규칙:
 *   - 스킴과 포트는 정확히 일치해야 한다 (http 항목이 https 요청을 허용하지 않는다)
 *   - `*`는 점(.)을 넘지 않으며 호스트 전체에 앵커된다 (`evil.com/?x=https://ninjalabsfe-a.vercel.app` 불가)
 *   - 비교는 요청 오리진의 scheme/host/port만 보고 경로·쿼리는 무시한다
 *
 * 주의: vercel.app 같은 공용 호스팅 도메인(아무나 하위 호스트를 등록할 수 있는 접미사) 위의 와일드카드는 `*`의 위치와
 * 무관하게 안전하지 않다 - `https://ninjalabsfe-*-team.vercel.app`도 공격자가 `ninjalabsfe-evil-team`이라는 프로젝트를
 * 만들면 통과한다 (returnTo로 로그인 코드 탈취). 그래서 등록 가능 도메인(registrable domain, 마지막 두 레이블)이
 * 공용 호스팅 접미사인 와일드카드 항목은 **전부 거부**한다 - 기동 시 error 로그를 남기고 목록에서 제외되므로 어떤
 * 오리진과도 매칭되지 않는다 (CORS/returnTo 모두). 같은 이유로 `*`가 등록 가능 도메인 자리(마지막 두 레이블: `https://*.com`, `https://ninjalabs-*.com`)에
 * 있는 항목도 거부한다 - 그 자리는 아무나 등록할 수 있다. Vercel preview는 브랜치 고정 별칭을 **정확한 항목**으로 넣는다
 * (`https://ninjalabsfe-git-develop-<team>.vercel.app`) - 또는 커스텀 preview 도메인을 쓴다.
 */
const ENTRY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#:@]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i;
const LABEL = /^[a-z0-9-]*\*?[a-z0-9-]*$/;

type Pattern = { protocol: string; port: string; host: RegExp };


/** 누구나 하위 호스트를 등록할 수 있는 공용 호스팅 접미사 - 이 도메인 위의 와일드카드 항목은 위치와 무관하게 거부 대상 */
export const SHARED_HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  'vercel.app', 'netlify.app', 'pages.dev', 'github.io', 'railway.app',
  'herokuapp.com', 'onrender.com', 'fly.dev', 'web.app', 'firebaseapp.com',
  'workers.dev', 'vercel.dev', 'now.sh', 'surge.sh', 'glitch.me', 'amplifyapp.com', 'azurewebsites.net', 'trycloudflare.com',
  'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'repl.co', 'replit.dev', 'csb.app', 'stackblitz.io', 'deno.dev', 'lovable.app',
]);

/**
 * 와일드카드 호스트의 등록 가능 도메인(마지막 두 레이블)이 공용 호스팅 접미사인가.
 * 대소문자 무시, 끝의 점(`vercel.app.`) 무시 - 포트는 호출 전에 이미 분리돼 있다.
 */
export function isSharedHostingWildcard(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.+$/, '').split('.');
  if (!labels.some((label) => label.includes('*'))) return false;
  return SHARED_HOSTING_SUFFIXES.has(labels.slice(-2).join('.'));
}

function defaultPort(protocol: string): string {
  return protocol === 'http:' ? '80' : protocol === 'https:' ? '443' : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class OriginAllowlist {
  private static readonly logger = new Logger(OriginAllowlist.name);
  private readonly exact = new Set<string>();
  /** 정확한 항목의 호스트만 (allowsHostname용 - 스킴/포트 무시) */
  private readonly exactHosts = new Set<string>();
  private readonly patterns: Pattern[] = [];

  constructor(entries: Iterable<string>) {
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      const match = ENTRY.exec(entry);
      if (!match) continue; // 잘못된 항목은 아무것도 허용하지 않는다 (조용히 전체 허용으로 넘어가지 않음)
      const protocol = `${match[1].toLowerCase()}:`;
      const host = match[2].toLowerCase();
      const port = match[3] ?? defaultPort(protocol);
      if (!host.includes('*')) {
        this.exact.add(`${protocol}//${host}:${port}`);
        this.exactHosts.add(host);
        continue;
      }
      const labels = host.split('.');
      const wildcardCount = (host.match(/\*/g) ?? []).length;
      const literal = host.replace(/\*/g, '').replace(/\./g, '');
      if (wildcardCount !== 1 || !literal || !labels.every((label) => LABEL.test(label))) continue;
      if (labels.filter(Boolean).slice(-2).some((label) => label.includes('*'))) {
        OriginAllowlist.logger.error(
          `origin allowlist entry "${entry}" REJECTED: the * sits in the registrable domain (last two labels), so it would match domains anyone can register ` +
          `(https://*.com, https://ninjalabs-*.com); put the wildcard in a label left of your own domain (https://preview-*.ninjalabs.xyz)`,
        );
        continue;
      }
      if (isSharedHostingWildcard(host)) {
        OriginAllowlist.logger.error(
          `origin allowlist entry "${entry}" REJECTED: a wildcard on a shared hosting domain matches hosts anyone can register ` +
          `(e.g. an attacker project named "ninjalabsfe-evil-team"); list the stable branch alias as an exact entry instead ` +
          `(https://ninjalabsfe-git-develop-<team>.vercel.app) or use a custom preview domain`,
        );
        continue;
      }
      const source = labels.map((label) => escapeRegExp(label).replace('\\*', '[a-z0-9-]*')).join('\\.');
      this.patterns.push({ protocol, port, host: new RegExp(`^${source}$`) });
    }
  }

  /** `CORS_ORIGINS=a, https://b-*.vercel.app` 형태의 env 값에서 생성 */
  static fromEnv(value: string | undefined | null): OriginAllowlist {
    return new OriginAllowlist((value ?? '').split(','));
  }

  /** 허용 목록이 비어 있는지 (기본값 적용 여부 판단용) */
  get size(): number {
    return this.exact.size + this.patterns.length;
  }

  /**
   * 호스트 이름만 비교 - 스킴·포트를 모르는 값(Cloudflare Turnstile siteverify의 `hostname`)용. 정확한 항목의 호스트이거나
   * 와일드카드 항목의 호스트 패턴에 맞으면 true. 대소문자·끝의 점 무시. 공용 호스팅 와일드카드는 생성 시 이미 빠져 있다.
   */
  allowsHostname(hostname: string | undefined | null): boolean {
    if (typeof hostname !== 'string') return false;
    const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return false;
    if (this.exactHosts.has(host)) return true;
    return this.patterns.some((pattern) => pattern.host.test(host));
  }

  allows(origin: string | undefined | null): boolean {
    if (!origin) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    const protocol = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const port = url.port || defaultPort(protocol);
    if (this.exact.has(`${protocol}//${host}:${port}`)) return true;
    return this.patterns.some(
      (pattern) => pattern.protocol === protocol && pattern.port === port && pattern.host.test(host),
    );
  }
}
