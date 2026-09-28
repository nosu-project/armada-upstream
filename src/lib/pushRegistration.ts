/**
 * Serializes mutations and makes each queued value a new generation.
 *
 * A queued generation that has not started is skipped when superseded. A
 * running worker receives `isCurrent` and checks it between network calls;
 * the newest snapshot then runs on the same serial tail.
 */
export class LatestSerialRunner<T, R> {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: (value: T, isCurrent: () => boolean) => Promise<R>,
  ) {}

  run(value: T): Promise<R | undefined> {
    const generation = ++this.generation;
    const work = this.tail.then(async () => {
      if (generation !== this.generation) return undefined;
      return this.worker(value, () => generation === this.generation);
    });
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  /**
   * Queue work that must run even if a newer latest-value arrives (logout and
   * explicit disable use this to remove the old account before a new one can
   * register). It first supersedes any in-flight latest snapshot.
   */
  runExclusive(value: T): Promise<R> {
    this.generation += 1;
    const work = this.tail.then(() => this.worker(value, () => true));
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  /** Supersede queued/running work without scheduling another generation. */
  invalidate(): void {
    this.generation += 1;
  }
}
