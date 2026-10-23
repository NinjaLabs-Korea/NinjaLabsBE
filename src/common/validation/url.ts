import { buildMessage, isURL, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * URL 입력 검증 — DTO 필드에 붙여 쓴다. 전부 http(s)만 허용한다 (`javascript:`/`data:` 차단).
 *
 *   IsHttpUrl()                외부 링크 (externalUrl, portfolioUrl, submissionUrl, repositoryUrl)
 *   IsHttpUrlOrMediaPath()     이미지 — `POST /admin/media`가 돌려주는 상대 경로 `/media/<uuid>`도 허용 (thumbnailUrl, imageUrl, coverImageUrl)
 *   IsHttpUrlOrSitePath()      사이트 내부 라우트 `/bounties/<slug>`도 허용 (highlight linkUrl). `//host` 같은 프로토콜 상대 URL은 거부
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

export const IsHttpUrlOrMediaPath = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isHttpUrlOrMediaPath',
      validator: {
        validate: (value) => isHttpUrl(value) || isMediaPath(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be an http(s) URL or a /media/<uuid> path`, options),
      },
    },
    options,
  );

export const IsHttpUrlOrSitePath = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isHttpUrlOrSitePath',
      validator: {
        validate: (value) => isHttpUrl(value) || isSitePath(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be an http(s) URL or a site-relative path`, options),
      },
    },
    options,
  );
