import { BadRequestException, NotFoundException } from '@nestjs/common';
import { buildMessage, isURL, ValidateBy, ValidationOptions } from 'class-validator';
import type { DatabaseService } from '../database/database.service';

/**
 * URL 입력 검증 — DTO 필드에 붙여 쓴다. 전부 http(s)만 허용한다 (`javascript:`/`data:` 차단).
 *
 *   IsHttpUrl()                외부 링크 (externalUrl, portfolioUrl, submissionUrl, repositoryUrl)
 *   IsPublicHttpUrl()          사용자가 내는 외부 링크(제출·지원 URL): IsHttpUrl + localhost·사설/루프백/링크로컬 IP·점 없는 내부 호스트 거부 (운영자·공개 프로필이 열어 볼 수 있어야 한다)
 *   IsHttpUrlOrMediaPath()     이미지 — 공개 http(s) URL(IsPublicHttpUrl과 같은 호스트 규칙) 또는 `POST /admin/media`가 돌려주는 상대 경로 `/media/<uuid>` (thumbnailUrl, imageUrl, coverImageUrl)
 *   IsHttpUrlOrSitePath()      공개 http(s) URL(IsPublicHttpUrl과 같은 호스트 규칙) 또는 사이트 내부 라우트 `/bounties/<slug>` (highlight linkUrl). `//host` 같은 프로토콜 상대 URL은 거부
 *   IsSafeUrl()                **수정 DTO 전용 완화 규칙** — http(s) 절대 URL, `/` 하나로 시작하는 아무 경로, 스킴 없는 bare host (레거시 행 보호, 아래 참고)
 *
 * 사이트 경로는 FE 라우터와 리버스 프록시가 서로 다르게 정규화할 수 있는 입력을 전부 거부한다:
 * 퍼센트 인코딩된 슬래시/역슬래시(`%2f`, `%5c`), 제어 문자, `..`로 디코딩되는 세그먼트(`%2e%2e`, `..;x` 같은 경로 파라미터 꼼수 포함).
 */
const MAX_URL_LENGTH = 2048;
const MEDIA_PATH = /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `/`로 시작하고 `//`로 시작하지 않으며 공백·역슬래시가 없다 — 세그먼트 검사는 isSitePath가 이어서 한다 */
const SITE_PATH = /^\/(?!\/)[^\s\\]*$/;
const HTTP_URL_PREFIX = /^https?:\/\/[^/?#\\]/i;
const ENCODED_SLASH = /%(2f|5c)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** http(s) + `//` + 호스트 — userinfo(`user:pw@`)와 `https:example.com`/`https:/x` 같은 변형은 거부 */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !HTTP_URL_PREFIX.test(value)) return false;
  if (CONTROL_CHARS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || !url.hostname) return false;
  return isURL(value, { protocols: ['http', 'https'], require_protocol: true, require_tld: false, disallow_auth: true });
}

const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet'];

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/**
 * 인터넷에서 열 수 있는 호스트인가 (사용자 입력 링크용). WHATWG URL이 `2130706433`, `0x7f.1` 같은 IPv4 변형을 점-십진수로 정규화하므로 `url.hostname`을 본다.
 * IPv6는 글로벌 유니캐스트(2000::/3)만 허용한다 (루프백·ULA·링크로컬·IPv4-mapped 전부 거부).
 */
export function isPublicHostname(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[')) return /^\[[23]/.test(host);
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const parts = octets.map(Number);
    return parts.every((part) => part <= 255) && !isPrivateIpv4(parts);
  }
  if (host === 'localhost' || !host.includes('.')) return false;
  return !PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 문자열이고 길이 상한(MAX_URL_LENGTH)을 넘는가 - 검증 실패 메시지를 고르는 데만 쓴다 */
function isTooLongUrl(value: unknown): boolean {
  return typeof value === 'string' && value.length > MAX_URL_LENGTH;
}

export function isPublicHttpUrl(value: unknown): boolean {
  if (!isHttpUrl(value)) return false;
  try {
    return isPublicHostname(new URL(value as string).hostname);
  } catch {
    return false;
  }
}

export function isMediaPath(value: unknown): boolean {
  return typeof value === 'string' && MEDIA_PATH.test(value);
}

function percentDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** 세그먼트(원문·디코딩본·`;` 앞부분)가 `.` 또는 `..`로 해석될 수 있는가 */
function isDotSegment(segment: string): boolean {
  const decoded = percentDecode(segment);
  if (decoded === null) return true; // 깨진 퍼센트 인코딩은 거부
  if (CONTROL_CHARS.test(decoded) || /[/\\]/.test(decoded) || ENCODED_SLASH.test(decoded)) return true;
  const forms = [segment, decoded, segment.split(';')[0], decoded.split(';')[0]];
  return forms.some((form) => form === '..' || form === '.');
}

export function isSitePath(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !SITE_PATH.test(value)) return false;
  if (CONTROL_CHARS.test(value) || ENCODED_SLASH.test(value)) return false;
  const path = value.split(/[?#]/, 1)[0];
  return path.split('/').slice(1).every((segment) => !isDotSegment(segment));
}

/** 이미지 필드의 엄격 규칙 (생성 DTO 검증과 수정 시 "바뀐 값" 검사가 같이 쓴다) */
export function isPublicHttpUrlOrMediaPath(value: unknown): boolean {
  return isPublicHttpUrl(value) || isMediaPath(value);
}

/**
 * 수정 DTO는 완화 규칙(IsSafeUrl)이라 레거시 저장값을 되보내는 PATCH를 받는다. 그렇다고 수정이 엄격 규칙의 우회로가 되면 안 된다 -
 * 저장값과 **다른** 새 값(null로 지우기 제외)은 생성과 같은 엄격 규칙을 통과해야 한다. 위반이면 true.
 */
export function changedUrlViolates(next: string | null | undefined, stored: string | null | undefined, strict: (value: unknown) => boolean): boolean {
  return typeof next === 'string' && next !== stored && !strict(next);
}

/** 수정 시 "바뀐 URL" 검사를 받을 수 있는 테이블과 컬럼 (SQL에 끼우는 식별자라 사용자 입력이 아닌 이 고정 목록만 쓴다) */
const STRICT_URL_TARGETS = {
  notice: { columns: ['external_url', 'thumbnail_url'], notDeleted: true },
  platform_highlight: { columns: ['image_url', 'link_url'], notDeleted: false },
  bounty: { columns: ['cover_image_url'], notDeleted: true },
} as const;

type StrictUrlTable = keyof typeof STRICT_URL_TARGETS;

export interface ChangedUrlPair {
  /** PATCH 본문의 새 값 (undefined = 안 보냄, null = 지우기) */
  next: string | null | undefined;
  column: string;
  strict: (value: unknown) => boolean;
  /** 위반 시 400 본문 (생성 DTO의 메시지와 같은 문구) */
  message: string;
}

/**
 * 수정(PATCH)에서 저장값과 **다른** 새 URL이 생성과 같은 엄격 규칙을 지키는지 검사한다 (changedUrlViolates 참고).
 * 호출자의 트랜잭션 안에서 행을 `FOR UPDATE`로 읽어 비교하므로 동시 수정과 어긋나지 않는다. 행이 없으면 404 `notFoundCode`.
 * 보낸 URL이 없거나 전부 null이면 쿼리하지 않는다 (404는 호출자의 UPDATE가 낸다).
 */
export async function assertChangedUrlsStrict(
  tx: Pick<DatabaseService, 'query'>,
  options: { table: StrictUrlTable; id: string; notFoundCode: string; pairs: ChangedUrlPair[] },
): Promise<void> {
  const target = STRICT_URL_TARGETS[options.table];
  if (!target) throw new Error(`unsupported table: ${String(options.table)}`);
  const pairs = options.pairs.filter((pair) => typeof pair.next === 'string');
  if (!pairs.length) return;
  for (const pair of pairs) {
    if (!(target.columns as readonly string[]).includes(pair.column)) throw new Error(`unsupported column: ${pair.column}`);
  }
  const columns = [...new Set(pairs.map((pair) => pair.column))].join(', ');
  const stored = await tx.query<Record<string, string | null>>(
    `SELECT ${columns} FROM ${options.table} WHERE id = $1${target.notDeleted ? ' AND deleted_at IS NULL' : ''} FOR UPDATE`,
    [options.id],
  );
  if (!stored.rowCount) throw new NotFoundException(options.notFoundCode);
  for (const pair of pairs) {
    if (changedUrlViolates(pair.next, stored.rows[0][pair.column], pair.strict)) throw new BadRequestException([pair.message]);
  }
}

export const IsHttpUrl = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isHttpUrl',
      validator: {
        validate: (value) => isHttpUrl(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be an http(s) URL`, options),
      },
    },
    options,
  );

export const IsPublicHttpUrl = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isPublicHttpUrl',
      validator: {
        validate: (value) => isPublicHttpUrl(value),
        // 너무 긴 URL은 "공개 URL이어야 한다"가 아니라 길이 문제로 알려 준다 (FE가 긴 링크와 localhost 링크를 구분해 안내할 수 있게)
        defaultMessage: (args) =>
          isTooLongUrl(args?.value)
            ? `${args?.property} must be at most ${MAX_URL_LENGTH} characters`
            : buildMessage((prefix) => `${prefix}$property must be a public http(s) URL (no localhost or private addresses)`, options)(args),
      },
    },
    options,
  );

export const IsHttpUrlOrMediaPath = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isHttpUrlOrMediaPath',
      validator: {
        // 이미지는 공개 페이지가 열고 Next 이미지 최적화가 서버에서 가져온다 - localhost·사설 IP·내부 호스트는 공지 externalUrl처럼 거부
        validate: (value) => isPublicHttpUrl(value) || isMediaPath(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be a public http(s) URL (no localhost or private addresses) or a /media/<uuid> path`, options),
      },
    },
    options,
  );

export const IsHttpUrlOrSitePath = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isHttpUrlOrSitePath',
      validator: {
        // 하이라이트 링크는 공개 Hall of Fame이 연다 - localhost·사설 IP·내부 호스트는 공지 externalUrl처럼 거부
        validate: (value) => isPublicHttpUrl(value) || isSitePath(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be a public http(s) URL (no localhost or private addresses) or a site-relative path`, options),
      },
    },
    options,
  );

/**
 * 완화 규칙 — **수정(PATCH) DTO 전용**. FE는 수정 때 바뀌지 않은 필드도 저장된 값 그대로 되보내므로, 엄격 규칙(위 세 가지) 이전에
 * 저장된 레거시 값(`/uploads/x.png` 같은 사이트 경로, `/bounties/x`를 이미지에 쓴 행 등)이 있으면 **모든** PATCH가 400이 된다.
 * 그래서 수정은 "위험하지 않은 것"만 거른다: http(s) 절대 URL(호스트 필수, userinfo 불가), `/` 하나로 시작하는 사이트 경로,
 * 또는 스킴 없는 bare host(`cdn.example/x.png`, `www.injective.com/blog` — 엄격 규칙 이전에 관리자가 스킴 없이 입력한 레거시 값).
 * bare host는 스킴이 없으므로 브라우저가 실행할 수 없고 FE `safeHttpUrl`은 링크/이미지로 그리지 않는다 — 막으면 그 행의 **모든** PATCH가 400이 될 뿐이다.
 * `javascript:`/`data:`/`vbscript:` 등 다른 스킴, 프로토콜 상대(`//host`, `/\host`), 제어 문자, 공백·역슬래시는 거부.
 * 생성 DTO는 계속 엄격 규칙을 쓴다. (0014가 엄격 규칙에 안 맞는 기존 행 수를 RAISE NOTICE로 보고한다.)
 */
const LENIENT_SITE_PATH = /^\/(?![/\\])/;
/** 스킴 없는 `host.tld[:port][/path]` — 레이블은 영숫자/하이픈, 마지막 레이블은 글자 2자 이상 (`javascript:x`, `localhost:3000`은 해당 없음) */
/** `scheme://` 뒤 첫 `/ ? #` 전(authority)에 역슬래시가 있다 */
const ABSOLUTE_AUTHORITY_BACKSLASH = /^[a-z]+:\/\/[^/?#]*\\/i;
const BARE_HOST_URL =/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;

export function isSafeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (LENIENT_SITE_PATH.test(value)) return true;
  if (BARE_HOST_URL.test(value)) return true; // 레거시 스킴 없는 값 - 실행 불가, 위 주석
  if (!HTTP_URL_PREFIX.test(value)) return false; // 다른 스킴·프로토콜 상대는 전부 여기서 끝난다
  // 절대 URL의 공백, authority(호스트 부분)의 역슬래시 거부 (위 주석의 규칙) — WHATWG URL은 `\`를 `/`로 읽어 `https://evil.com\.example.com`의
  // 호스트를 evil.com으로 보지만 다른 파서는 호스트에 포함시킨다(파서 차이). new URL()은 앞뒤 공백도 조용히 잘라 통과시켰다.
  // 경로/프래그먼트의 역슬래시는 엄격 규칙(isHttpUrl)도 받으므로 여기서 막으면 생성 때 통과한 값의 수정이 400이 된다.
  if (/\s/.test(value) || ABSOLUTE_AUTHORITY_BACKSLASH.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const IsSafeUrl = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isSafeUrl',
      validator: {
        validate: (value) => isSafeUrl(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be an http(s) URL or a site-relative path starting with /`, options),
      },
    },
    options,
  );
