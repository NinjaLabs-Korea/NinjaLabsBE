import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { isIPv6 } from 'net';

/**
 * rate limit 버킷 키로 쓰는 클라이언트 IP. IPv4는 그대로, IPv6는 첫 64비트(/64 접두사)로 묶는다.
 *
 * IPv6 가입자는 보통 /64(또는 /56) 전체를 받는다 — 주소 하나당 버킷이면 한 사람이 같은 /64 안에서 요청마다 다른 주소를 써
 * 전역 120/min · check-nickname 30/min 같은 IP 한도를 사실상 무한히 우회할 수 있다. 접두사 첫 64비트(네 hextet)만 키로 쓴다.
 * IPv4-mapped(`::ffff:1.2.3.4`)는 IPv4로 되돌린다 (듀얼스택 소켓이 IPv4 클라이언트를 이렇게 보고한다).
 * 알 수 없는 값(빈 값, 형식 오류)은 그대로 돌려준다 — 버킷 하나로 묶일 뿐 우회가 되지는 않는다.
 */
export function throttleIpKey(ip: string | undefined): string {
  const raw = (ip ?? '').trim().replace(/%.*$/, ''); // zone id(`fe80::1%eth0`) 제거
  if (!isIPv6(raw)) return raw;
  let text = raw.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text); // 끝의 IPv4 점 표기는 hextet 두 개
  if (dotted) {
    if (text.startsWith('::ffff:')) return dotted[0];
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const groups = tail === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** 전역(APP_GUARD) IP 기준 rate limit — 기본 ThrottlerGuard와 같고 추적 키만 `throttleIpKey`로 정규화한다 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return throttleIpKey(req.ip as string | undefined);
  }
}
