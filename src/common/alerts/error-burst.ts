/**
 * 슬라이딩 윈도우 버스트 감지 - `windowMs` 안에 `threshold`건을 **넘으면**(threshold+1번째) true.
 * 마지막 threshold+1개 시각만 들고 있으므로 초당 수천 건이 와도 메모리는 일정하다.
 */
export class ErrorBurstDetector {
  private readonly stamps: number[] = [];

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 한 건 기록하고, 지금 윈도우 안의 건수가 threshold를 넘었는지 돌려준다 */
  record(): boolean {
    const at = this.now();
    this.stamps.push(at);
    if (this.stamps.length > this.threshold + 1) this.stamps.shift();
    return this.stamps.length > this.threshold && at - this.stamps[0] <= this.windowMs;
  }
}
