/**
 * 최소 쿠키 유틸 - `cookie-parser` 의존성 없이 요청의 Cookie 헤더를 읽고 Set-Cookie 값을 만든다.
 * 이 서비스가 읽는 쿠키는 `ninja_rt` 하나뿐이다 (auth/session-cookie.ts).
 */

/** `a=1; b=2` → `{ a: '1', b: '2' }`. 같은 이름이 여러 번 오면 **첫 값**(RFC 6265: 경로가 더 구체적인 쿠키가 먼저 온다). 잘못된 % 인코딩은 원문 유지 */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export type CookieAttributes = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAgeSeconds?: number;
};

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 6265 cookie-octet (따옴표·쉼표·세미콜론·역슬래시·공백·제어 문자 제외) */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Set-Cookie 헤더 값. 속성 순서: HttpOnly; Secure; SameSite; Path; Max-Age. 값은 인코딩하지 않으므로 cookie-octet만 허용(아니면 throw) */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes = {}): string {
  if (!COOKIE_NAME.test(name)) throw new Error(`invalid cookie name ${JSON.stringify(name)}`);
  if (!COOKIE_VALUE.test(value)) throw new Error(`invalid cookie value for ${name}`);
  const parts = [`${name}=${value}`];
  if (attributes.httpOnly) parts.push('HttpOnly');
  if (attributes.secure) parts.push('Secure');
  if (attributes.sameSite) parts.push(`SameSite=${attributes.sameSite}`);
  if (attributes.path) parts.push(`Path=${attributes.path}`);
  if (attributes.maxAgeSeconds !== undefined) {
    if (!Number.isInteger(attributes.maxAgeSeconds) || attributes.maxAgeSeconds < 0) throw new Error('Max-Age must be a non-negative integer');
    parts.push(`Max-Age=${attributes.maxAgeSeconds}`);
  }
  return parts.join('; ');
}
