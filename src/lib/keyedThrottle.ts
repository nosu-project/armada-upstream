/**
 * Coalesces per-key work: a key's first request fires after `debounceMs`, and a
 * key that fired less than `minGapMs` ago waits out the rest of the gap. Other
 * keys are unaffected, and repeats while a key is pending collapse into one.
 */
export class KeyedThrottle<T> {
  private readonly pending = new Map<string, T>();
  private readonly lastFired = new Map<string, number>();

  constructor(
    private readonly debounceMs: number,
    private readonly minGapMs: number,
  ) {}

  add(key: string, value: T): void {
    this.pending.set(key, value);
  }

  /** Milliseconds until the next pending key is due, or undefined when none is pending. */
  nextDelay(now: number): number | undefined {
    let soonest: number | undefined;
    for (const key of this.pending.keys()) {
      const delay = this.delayFor(key, now);
      if (soonest === undefined || delay < soonest) soonest = delay;
    }
    return soonest;
  }

  /** The pending values that are due now, marked fired. */
  takeDue(now: number): T[] {
    const due: T[] = [];
    for (const [key, value] of this.pending) {
      if (this.gapLeft(key, now) > 0) continue;
      due.push(value);
      this.pending.delete(key);
      this.lastFired.set(key, now);
    }
    return due;
  }

  private gapLeft(key: string, now: number): number {
    const last = this.lastFired.get(key);
    return last === undefined ? 0 : Math.max(0, last + this.minGapMs - now);
  }

  private delayFor(key: string, now: number): number {
    return Math.max(this.debounceMs, this.gapLeft(key, now));
  }
}
