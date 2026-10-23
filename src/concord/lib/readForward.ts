/**
 * Reading history FORWARD from a point in time. Relays and the store both answer
 * a limited filter newest-first, so a truncated window says nothing about its
 * oldest rows — the ones a reader scrolling down from a jumped-to message needs.
 * A window is therefore only accepted when it came back COMPLETE: an over-full
 * one is halved and retried, a sparse one is grown for the next read.
 */

export interface WindowRead<T> {
  rows: T[];
  /** Every row in `[since, until]` came back. */
  complete: boolean;
  /** A source failed: nothing about the window is known. */
  failed?: boolean;
}

export interface ReadForwardResult<T> {
  /** Every row read, including those of over-full windows (real rows, just not yet covered). */
  rows: T[];
  /** The last second read completely from `from`; absent when none was. */
  coveredTo?: number;
  failed: boolean;
}

export async function readForward<T>(opts: {
  /** First second to read (inclusive). */
  from: number;
  /** Last second worth reading (inclusive). */
  ceiling: number;
  /** Stop once this many counted rows are covered. */
  want: number;
  /** First window's width in seconds. */
  span: number;
  maxReads: number;
  read: (since: number, until: number) => Promise<WindowRead<T>>;
  count: (rows: readonly T[]) => number;
  signal?: AbortSignal;
}): Promise<ReadForwardResult<T>> {
  const rows: T[] = [];
  let at = opts.from;
  let span = Math.max(0, Math.floor(opts.span));
  let coveredTo: number | undefined;
  let got = 0;
  for (let i = 0; i < opts.maxReads && at <= opts.ceiling; i++) {
    if (opts.signal?.aborted) break;
    const until = Math.min(opts.ceiling, at + span);
    const r = await opts.read(at, until);
    rows.push(...r.rows);
    if (r.failed) return { rows, coveredTo, failed: true };
    // A single second denser than a read can hold is taken as read: it cannot be split.
    if (!r.complete && until > at) {
      span = Math.floor((until - at) / 2);
      continue;
    }
    coveredTo = until;
    got += opts.count(r.rows);
    if (got >= opts.want || until >= opts.ceiling) break;
    at = until + 1;
    span = Math.max(1, span * 2);
  }
  return { rows, coveredTo, failed: false };
}
