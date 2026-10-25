import { IpThrottlerGuard, throttleIpKey } from './ip-throttler.guard';

describe('throttleIpKey', () => {
  it('keeps IPv4 as is (and trims)', () => {
    expect(throttleIpKey('203.0.113.7')).toBe('203.0.113.7');
    expect(throttleIpKey(' 10.1.2.3 ')).toBe('10.1.2.3');
  });

  it('maps IPv4-mapped IPv6 back to the IPv4 address (dual-stack sockets)', () => {
    expect(throttleIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(throttleIpKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('maps the hex spelling of an IPv4-mapped address too, instead of pooling every such client into the "::" bucket', () => {
    expect(throttleIpKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(throttleIpKey('0:0:0:0:0:ffff:0a01:0203')).toBe('10.1.2.3');
    expect(throttleIpKey('::ffff:0:0')).toBe('0.0.0.0');
    expect(throttleIpKey('::1')).toBe('0:0:0:0::/64'); // not mapped
    expect(throttleIpKey('::fffe:cb00:7107')).toBe('0:0:0:0::/64');
  });

  it('buckets IPv6 by /64, so one subscriber rotating addresses inside its prefix shares one bucket', () => {
    const key = throttleIpKey('2001:db8:abcd:12:1111:2222:3333:4444');
    expect(key).toBe('2001:db8:abcd:12::/64');
    expect(throttleIpKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff')).toBe(key);
    expect(throttleIpKey('2001:DB8:ABCD:0012::1')).toBe(key);
    expect(throttleIpKey('2001:db8:abcd:13::1')).not.toBe(key); // next /64 is a different subscriber
  });

  it('expands :: compression before taking the prefix', () => {
    expect(throttleIpKey('::1')).toBe('0:0:0:0::/64');
    expect(throttleIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(throttleIpKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(throttleIpKey('::')).toBe('0:0:0:0::/64');
    expect(throttleIpKey('1:2:3:4:5:6:7::')).toBe('1:2:3:4::/64');
    expect(throttleIpKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(throttleIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('passes unknown values through (one shared bucket at worst, never a bypass)', () => {
    expect(throttleIpKey(undefined)).toBe('');
    expect(throttleIpKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('IpThrottlerGuard', () => {
  it('tracks by the normalized client IP', async () => {
    const guard = new IpThrottlerGuard({ throttlers: [] }, {} as never, {} as never);
    const tracker = (guard as unknown as { getTracker(req: Record<string, unknown>): Promise<string> }).getTracker.bind(guard);
    expect(await tracker({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).toBe('2001:db8:1:2::/64');
    expect(await tracker({ ip: '198.51.100.9' })).toBe('198.51.100.9');
  });
});
