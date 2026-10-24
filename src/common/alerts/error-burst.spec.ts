import { ErrorBurstDetector } from './error-burst';

describe('ErrorBurstDetector', () => {
  it('fires on the (threshold+1)th event inside the window, and keeps firing while the rate stays high', () => {
    let clock = 0;
    const detector = new ErrorBurstDetector(20, 5 * 60_000, () => clock);
    const results: boolean[] = [];
    for (let i = 0; i < 22; i++) { results.push(detector.record()); clock += 1000; }
    expect(results.slice(0, 20).every((fired) => !fired)).toBe(true);
    expect(results[20]).toBe(true);
    expect(results[21]).toBe(true);
  });

  it('does not fire when the same number of errors is spread over more than the window', () => {
    let clock = 0;
    const detector = new ErrorBurstDetector(20, 5 * 60_000, () => clock);
    const fired: boolean[] = [];
    for (let i = 0; i < 100; i++) { fired.push(detector.record()); clock += 16_000; } // 21 events span 320s > 300s
    expect(fired.some(Boolean)).toBe(false);
  });

  it('keeps constant memory under a flood', () => {
    const detector = new ErrorBurstDetector(20, 5 * 60_000, () => 0);
    for (let i = 0; i < 10_000; i++) detector.record();
    expect(detector['stamps'].length).toBe(21);
  });
});
