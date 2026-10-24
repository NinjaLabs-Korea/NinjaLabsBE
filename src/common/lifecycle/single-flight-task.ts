/**
 * 종료(SIGTERM) 때 백그라운드 작업이 끝날 때까지 기다리는 최대 시간. Railway `drainingSeconds`(30초, .railway/railway.ts)는
 * SIGTERM에서 SIGKILL까지의 시간이다. 그 안에 HTTP 드레인과 풀 종료가 끝나야 하므로 여유를 둔다 (docs/runbook.md "배포 중 종료 순서").
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

/**
 * 크론 작업 하나의 "한 번에 하나만 실행" 가드와 종료 드레인을 함께 맡는다.
 *
 *   run(fn)  이전 실행이 아직 돌고 있거나 stop()이 불린 뒤라면 fn을 실행하지 않고 바로 끝난다 (겹친 크론 틱은 건너뛴다).
 *            fn의 에러는 그대로 호출자에게 전파된다.
 *   stop()   이후의 run()을 전부 건너뛰게 하고, 돌고 있던 실행이 끝날 때까지 최대 timeoutMs 기다린다.
 *            제때 끝나면 true, 시간이 다 되면 false. 실행의 에러는 run() 쪽에서 이미 전파됐으므로 여기서는 무시한다.
 *
 * 쓰는 쪽은 `beforeApplicationShutdown()`에서 stop()을 await한다. Nest는 그 훅이 모두 끝난 뒤 HTTP 서버를 닫고, 그다음
 * `onApplicationShutdown()`에서 DB 풀을 닫는다(DatabaseService). 그래서 드레인 중인 작업은 아직 살아 있는 풀을 쓴다.
 * 긴 작업은 단계 사이에서 `isStopping`을 확인해 일찍 멈춘다 (예: NftJobWorker가 배치의 다음 잡으로 넘어가기 전).
 */
export class SingleFlightTask {
  private current: Promise<void> | null = null;
  private stopped = false;

  /** 지금 실행 중인가 */
  get isRunning(): boolean {
    return this.current !== null;
  }

  /** stop()이 불렸는가 — 긴 작업이 단계 사이에서 확인한다 */
  get isStopping(): boolean {
    return this.stopped;
  }

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.stopped || this.current) return;
    const execution = (async () => fn())();
    this.current = execution;
    try {
      await execution;
    } finally {
      this.current = null;
    }
  }

  async stop(timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<boolean> {
    this.stopped = true;
    const inFlight = this.current;
    if (!inFlight) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([inFlight.then(() => true, () => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
