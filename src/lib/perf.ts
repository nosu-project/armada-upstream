/**
 * Boot/runtime profiler: where the wall clock actually goes.
 *
 * This exists because "the app takes five seconds to show cached data" is not
 * answerable by reading the code. The boot is a chain — login storage, a dozen
 * IndexedDB opens, tens of KV transactions, unbounded plane reads, sliced
 * decrypt bursts, relay rounds with multi-second ceilings — and every link is
 * individually defensible. Guessing which one dominates has a poor track
 * record; the ONLY thing that settles it is a number per link, from the device
 * that's slow.
 *
 * Two shapes, because the two questions are different:
 *
 *  - {@link perfMark} answers "when did this happen?" — one-shot boot
 *    milestones, reported as a timeline from page load.
 *  - {@link perfTime}/{@link perfCount} answer "what did this cost in total?" —
 *    repeated operations, aggregated by label into count / total / max / a
 *    caller-supplied unit (rows, wraps, editions), so a thousand cheap calls
 *    are distinguishable from one expensive one.
 *
 * ALWAYS ON, deliberately. The instrument is a `Map` lookup and a subtraction,
 * which is nothing next to the IndexedDB transaction or the Schnorr verify it
 * measures — and a profiler that has to be enabled before the run is a profiler
 * nobody has data from when the report arrives. Only the *report* is opt-in.
 *
 * Read it in the console:
 *
 *   __armadaPerf()        // timeline + aggregate table, sorted by total cost
 *   __armadaPerf(true)    // same, then reset the aggregates
 *
 * Not a substitute for the browser's own profiler — it is the map that says
 * which part of the flame graph to open.
 */

/** Page-load origin, so every mark reads as an offset a pasted log can be diffed on. */
const t0 = now();

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** One-shot boot milestones, in the order they were reached. */
const marks: { label: string; at: number; detail?: string }[] = [];

/** Aggregate per label. `unit` is a caller-defined work count (rows, wraps, …). */
interface Bucket {
  count: number;
  total: number;
  max: number;
  units: number;
  unitName?: string;
}

const buckets = new Map<string, Bucket>();

function bucket(label: string): Bucket {
  let b = buckets.get(label);
  if (!b) {
    b = { count: 0, total: 0, max: 0, units: 0 };
    buckets.set(label, b);
  }
  return b;
}

/**
 * Record a one-shot milestone (first paint of a timeline, login resolved, the
 * first store open). Repeats are kept — a milestone that happens twice on one
 * boot is itself the finding.
 */
export function perfMark(label: string, detail?: string): void {
  marks.push({ label, at: now() - t0, detail });
}

/**
 * Add `ms` (and optionally a work count) to `label`'s aggregate.
 *
 * Separate from {@link perfTime} so a caller that already measured — or that
 * measures across an await it doesn't own — doesn't have to restructure.
 */
export function perfCount(label: string, ms: number, units?: number, unitName?: string): void {
  const b = bucket(label);
  b.count += 1;
  b.total += ms;
  if (ms > b.max) b.max = ms;
  if (units !== undefined) {
    b.units += units;
    b.unitName ??= unitName;
  }
}

/**
 * Time an async operation into `label`'s aggregate, counting the work it
 * returned. Records the cost of a rejection too: a read that throws after two
 * seconds spent those two seconds.
 *
 * `units` derives the work count from the result (e.g. `(rows) => rows.length`),
 * which is what separates "one query walked 40 000 records" from "400 queries
 * walked 100 each" — the two look identical in a total.
 */
export async function perfTime<T>(
  label: string,
  fn: () => Promise<T>,
  units?: (result: T) => number,
  unitName = "rows",
): Promise<T> {
  const start = now();
  try {
    const result = await fn();
    perfCount(label, now() - start, units?.(result), unitName);
    return result;
  } catch (error) {
    perfCount(label, now() - start);
    throw error;
  }
}

/** Time a synchronous operation into `label`'s aggregate. */
export function perfTimeSync<T>(label: string, fn: () => T, units?: (result: T) => number, unitName = "rows"): T {
  const start = now();
  try {
    const result = fn();
    perfCount(label, now() - start, units?.(result), unitName);
    return result;
  } catch (error) {
    perfCount(label, now() - start);
    throw error;
  }
}

/** The collected profile, for a report or a test. */
export interface PerfReport {
  /** Milliseconds since page load at the time of the report. */
  elapsed: number;
  timeline: { label: string; at: number; detail?: string }[];
  aggregates: {
    label: string;
    count: number;
    /** Total milliseconds spent under this label. */
    total: number;
    /** Mean milliseconds per call. */
    mean: number;
    max: number;
    units?: number;
    unitName?: string;
  }[];
}

/** Snapshot the profile, sorted by total cost descending. */
export function perfReport(): PerfReport {
  return {
    elapsed: now() - t0,
    timeline: marks.map((m) => ({ ...m })),
    aggregates: [...buckets.entries()]
      .map(([label, b]) => ({
        label,
        count: b.count,
        total: b.total,
        mean: b.count > 0 ? b.total / b.count : 0,
        max: b.max,
        ...(b.unitName ? { units: b.units, unitName: b.unitName } : {}),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Drop the aggregates (keeps the boot timeline, which is not repeatable). */
export function perfReset(): void {
  buckets.clear();
}

/**
 * Sample event-loop lag: schedule a 0ms timer every `intervalMs` and record how
 * late it actually fires.
 *
 * This is the one number that separates "storage is slow" from "the main thread
 * is busy", and they demand opposite fixes. Every IndexedDB result is delivered
 * by a task on the event loop, so a saturated loop inflates the measured latency
 * of a read that the database itself answered instantly — and a profile without
 * this number cannot tell the two apart. A `max` in the seconds means the loop
 * was blocked that long, and every storage figure in the report is an upper
 * bound rather than a cost.
 *
 * Returns a stop function. Sampling is a timer per interval; the sampler is
 * exactly the thing being measured, so it cannot lie in the cheap direction.
 */
export function startLoopLagSampler(intervalMs = 250): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const scheduled = now();
    setTimeout(() => {
      if (stopped) return;
      // Everything past `intervalMs` is the loop failing to get to us.
      perfCount("loop lag", Math.max(0, now() - scheduled - intervalMs));
      tick();
    }, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
  };
}

/** Test seam: drop everything, including the timeline. */
export function __resetPerfForTests(): void {
  buckets.clear();
  marks.length = 0;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Print the profile. Installed on `window` as `__armadaPerf`. */
function printReport(reset = false): PerfReport {
  const report = perfReport();
  console.log(
    `%c[armada perf]%c ${round(report.elapsed)}ms since page load`,
    "color:#c586ff;font-weight:bold",
    "color:inherit",
  );
  console.log("— boot timeline —");
  console.table(
    report.timeline.map((m) => ({ "+ms": round(m.at), milestone: m.label, detail: m.detail ?? "" })),
  );
  console.log("— cost by label (sorted by total) —");
  console.table(
    report.aggregates.map((a) => ({
      label: a.label,
      calls: a.count,
      "total ms": round(a.total),
      "mean ms": round(a.mean),
      "max ms": round(a.max),
      [a.unitName ?? "units"]: a.units ?? "",
    })),
  );
  if (reset) perfReset();
  return report;
}

// Expose the reader without making the module a side-effect import: every
// instrumented module already imports from here, so the first one to load
// installs it.
if (typeof window !== "undefined") {
  (window as unknown as { __armadaPerf?: (reset?: boolean) => PerfReport }).__armadaPerf = printReport;
}
