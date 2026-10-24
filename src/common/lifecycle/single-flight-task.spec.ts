import { SingleFlightTask } from './single-flight-task';

function gate() {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

describe('SingleFlightTask', () => {
  it('runs the function and reports isRunning only while it is in flight', async () => {
    const task = new SingleFlightTask();
    const g = gate();
    const fn = jest.fn(() => g.promise);
    const run = task.run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(task.isRunning).toBe(true);
    g.open();
    await run;
    expect(task.isRunning).toBe(false);
  });

  it('skips a run that starts while the previous one is still in flight, and runs again afterwards', async () => {
    const task = new SingleFlightTask();
    const g = gate();
    const fn = jest.fn(() => g.promise);
    const first = task.run(fn);
    await task.run(fn); // overlapping tick
    expect(fn).toHaveBeenCalledTimes(1);
    g.open();
    await first;
    await task.run(async () => undefined);
    await task.run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates the error (async or sync throw) and releases the slot', async () => {
    const task = new SingleFlightTask();
    await expect(task.run(async () => { throw new Error('async boom'); })).rejects.toThrow('async boom');
    expect(task.isRunning).toBe(false);
    await expect(task.run((() => { throw new Error('sync boom'); }) as () => Promise<void>)).rejects.toThrow('sync boom');
    expect(task.isRunning).toBe(false);
  });

  it('stop() with nothing in flight resolves true at once and every later run is skipped', async () => {
    const task = new SingleFlightTask();
    await expect(task.stop()).resolves.toBe(true);
    expect(task.isStopping).toBe(true);
    const fn = jest.fn(async () => undefined);
    await task.run(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stop() waits for the in-flight run to finish (even if it fails) and resolves true', async () => {
    const task = new SingleFlightTask();
    const g = gate();
    const run = task.run(() => g.promise);
    let stopped: boolean | undefined;
    const stopping = task.stop(10_000).then((drained) => { stopped = drained; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBeUndefined();
    g.fail(new Error('late failure'));
    await expect(run).rejects.toThrow('late failure');
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stop() gives up after the timeout and resolves false while the run keeps going', async () => {
    const task = new SingleFlightTask();
    const g = gate();
    const run = task.run(() => g.promise);
    await expect(task.stop(10)).resolves.toBe(false);
    expect(task.isRunning).toBe(true);
    g.open();
    await run;
  });
});
