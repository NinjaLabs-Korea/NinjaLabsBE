import { Logger } from '@nestjs/common';
import { onboardingLog } from './onboarding-log';

describe('onboardingLog', () => {
  const lineOf = (details: Record<string, unknown>) => {
    const logger = { log: jest.fn() } as unknown as Logger;
    onboardingLog(logger, 'test.event', details as never);
    return (logger.log as jest.Mock).mock.calls[0][0] as string;
  };

  it('keeps strings capped and primitives untouched', () => {
    const line = lineOf({ a: 'x'.repeat(500), n: 3, b: true, z: null });
    const parsed = JSON.parse(line.replace('[onboarding] ', ''));
    expect(parsed.a.length).toBeLessThan(260);
    expect(parsed).toMatchObject({ n: 3, b: true, z: null });
  });

  it('flattens query-string arrays/objects into one capped string instead of logging the nested structure', () => {
    const line = lineOf({ traceId: { a: 'y'.repeat(5000) }, providerError: ['p'.repeat(5000), 'q'] });
    const parsed = JSON.parse(line.replace('[onboarding] ', ''));
    expect(typeof parsed.traceId).toBe('string');
    expect(typeof parsed.providerError).toBe('string');
    expect(line.length).toBeLessThan(900);
  });
});
