import { createHash } from 'crypto';
import { UserThrottlerGuard } from './user-throttler.guard';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('UserThrottlerGuard tracker', () => {
  const guard = new UserThrottlerGuard({} as never, {} as never, {} as never);
  const tracker = (req: Record<string, unknown>) => (guard as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);

  it('is keyed by the sha256 of the logged-in user id, independent of the IP', async () => {
    const a = await tracker({ ip: '10.0.0.1', user: { userId: 'u-1' } });
    expect(a).toBe(`user:${sha256('u-1')}`);
    expect(a).not.toContain('u-1');
    expect(await tracker({ ip: '10.0.0.2', user: { userId: 'u-1' } })).toBe(a);
    expect(await tracker({ ip: '10.0.0.1', user: { userId: 'u-2' } })).not.toBe(a);
  });

  it('falls back to the (normalized) IP when no user is attached', async () => {
    expect(await tracker({ ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
    expect(await tracker({ ip: '2001:db8:1:2:3:4:5:6', user: {} })).toBe('ip:2001:db8:1:2::/64');
  });
});
