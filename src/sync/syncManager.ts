/**
 * The sync scheduler: hooks declare interest in a TOPIC and read the local
 * store; this manager is the only place that decides when a topic's pull
 * actually touches the network.
 *
 * Topics are the wire bus's scope strings (`c2:<channelIdHex>`,
 * `nip29:<relay>|<groupId>`, `dm`, ...): the same key a hook re-reads the
 * store on is the key it declares interest in. A topic's handler — registered
 * per key prefix by the module that owns that data — fetches and writes into
 * ArmadaDB; results reach readers the way every store write does (the wire
 * bus), so a completed run needs no return channel.
 *
 * What this centralizes, replacing the per-hook copies it will absorb:
 *
 *  - **Throttles.** `minIntervalMs` is the hard floor between two runs of one
 *    topic; `staleAfterMs` is how old the freshness stamp may get before a
 *    standing interest re-runs it (the `refetchInterval` replacement).
 *  - **Freshness is durable.** Stamps persist in KV (`sync-fresh:<topic>`),
 *    so "synced this channel 20s ago" survives a remount, a channel switch,
 *    and a relaunch — the per-mount refs that reset on every switch (and
 *    re-page every relay) are what this exists to delete.
 *  - **Scheduling.** Single-flight per topic; a few `visible` runs and one
 *    `background`/`prefetch` run at a time; paused while the document is
 *    hidden or the boot paint gate is closed; nudged on focus / online /
 *    visibility, where staleness decides whether anything actually runs.
 *
 * Skeleton semantics for readers: skeleton iff the local read was empty AND
 * `syncState(topic)` has never settled. `"settled"` means a run completed, or
 * the stamp was fresh enough that none was needed — either way an empty store
 * is then an answer, not a not-yet.
 *
 * Registration order is forgiving: a `want` for a topic with no registered
 * policy sits idle, and `registerSyncTopic` re-schedules, so a hook that
 * mounts before the owning module registers is picked up then.
 */
import { isBootGateOpen, onBootGateOpen } from "@/lib/bootGate";
import { KvPrefixCache } from "@/lib/db/kvCache";

export type SyncPriority = "visible" | "background" | "prefetch";

export type SyncStatus = "idle" | "pending" | "settled" | "error";

export interface SyncState {
  status: SyncStatus;
  /** When this topic's last run completed (ms epoch), if ever. Durable. */
  lastSyncedAt?: number;
}

export interface SyncCtx {
  topic: string;
  /** Aborted when the last interest releases (component unmounts). */
  signal: AbortSignal;
}

/**
 * Transport budgets, carried on the policy for the pool to enforce once
 * per-topic accounting exists there. Not enforced by the scheduler itself.
 */
export interface SyncBudget {
  maxEvents?: number;
  maxPages?: number;
  maxRelays?: number;
}

export interface TopicPolicy {
  /** Hard floor between two runs of one topic, however demanded. */
  minIntervalMs: number;
  /**
   * Age the stamp may reach before a standing interest re-runs the topic.
   * While any component holds a want, the topic re-syncs roughly this often.
   */
  staleAfterMs: number;
  /** Fetch and write into ArmadaDB. Results reach readers via the wire bus. */
  handler: (ctx: SyncCtx) => Promise<void>;
  budget?: SyncBudget;
}

export interface WantOpts {
  /** Bypass the staleness check once (still subject to `minIntervalMs`). */
  force?: boolean;
}

/** How many `visible`-priority topics may run concurrently. */
const MAX_VISIBLE_RUNS = 3;
/** How many `background`/`prefetch` topics may run concurrently (combined). */
const MAX_DEFERRED_RUNS = 1;
/** Ceiling on the failure backoff. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** Floor on any scheduled wake-up, coalescing bursts of near-term deadlines. */
const MIN_WAKE_MS = 50;

const PRIORITY_RANK: Record<SyncPriority, number> = { visible: 2, background: 1, prefetch: 0 };

const IDLE: SyncState = Object.freeze({ status: "idle" });

interface Want {
  priority: SyncPriority;
}

interface TopicRuntime {
  wants: Set<Want>;
  run?: { controller: AbortController; priority: SyncPriority };
  /** Min-interval / failure-backoff floor: no run starts before this. */
  nextEligibleAt: number;
  failures: number;
  /** One-shot staleness bypass, consumed by the next run. */
  forced: boolean;
  /** Published snapshot. Replaced, never mutated (useSyncExternalStore). */
  state: SyncState;
  listeners: Set<() => void>;
}

/** Registered policies, by topic-key prefix. Longest matching prefix wins. */
const policies = new Map<string, TopicPolicy>();

const topics = new Map<string, TopicRuntime>();

/**
 * Durable freshness stamps. In KV rather than memory so throttling survives
 * remounts and relaunches; cleared with the rest of KV on logout/purge.
 */
const stamps = new KvPrefixCache<number>({ prefix: "sync-fresh:" });

/**
 * Whether the stamp warm has SETTLED (not necessarily succeeded). Scheduling
 * waits for it so a fresh stamp can answer a boot-time want without a run; if
 * the warm failed, every topic just looks never-synced, which degrades to
 * syncing — never to wrongly skipping.
 */
let stampsSettled = false;

let wired = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Register the handler for a topic-key prefix (e.g. `"c2:"`). */
export function registerSyncTopic(prefix: string, policy: TopicPolicy): void {
  policies.set(prefix, policy);
  schedule();
}

/**
 * Declare interest in a topic. Returns a release; when the last interest
 * releases, an in-flight run is aborted and nothing further is scheduled.
 */
export function want(topic: string, priority: SyncPriority = "visible", opts?: WantOpts): () => void {
  ensureWired();
  const rt = runtime(topic);
  const token: Want = { priority };
  rt.wants.add(token);
  if (opts?.force) rt.forced = true;
  // A higher-priority want upgrades an in-flight run's lane, so capacity
  // accounting follows the demand (a prefetch a viewer is now waiting on
  // stops occupying the deferred lane).
  if (rt.run && PRIORITY_RANK[priority] > PRIORITY_RANK[rt.run.priority]) {
    rt.run.priority = priority;
  }
  schedule();
  return () => {
    if (!rt.wants.delete(token)) return;
    if (rt.wants.size === 0) {
      rt.run?.controller.abort();
      rt.forced = false;
    }
    schedule();
  };
}

/** The topic's current state. Stable snapshot identity between changes. */
export function syncState(topic: string): SyncState {
  return topics.get(topic)?.state ?? IDLE;
}

/** Re-render on state change. Returns an unsubscribe. */
export function onSyncState(topic: string, listener: () => void): () => void {
  const rt = runtime(topic);
  rt.listeners.add(listener);
  return () => {
    rt.listeners.delete(listener);
  };
}

function runtime(topic: string): TopicRuntime {
  let rt = topics.get(topic);
  if (!rt) {
    const stamp = stamps.get(topic);
    rt = {
      wants: new Set(),
      nextEligibleAt: 0,
      failures: 0,
      forced: false,
      state: stamp === undefined ? IDLE : { status: "idle", lastSyncedAt: stamp },
      listeners: new Set(),
    };
    topics.set(topic, rt);
  }
  return rt;
}

function publish(topic: string, rt: TopicRuntime, status: SyncStatus): void {
  const lastSyncedAt = stamps.get(topic);
  if (rt.state.status === status && rt.state.lastSyncedAt === lastSyncedAt) return;
  rt.state = lastSyncedAt === undefined ? { status } : { status, lastSyncedAt };
  for (const listener of [...rt.listeners]) {
    try {
      listener();
    } catch {
      // A listener must never break the scheduler for the others.
    }
  }
}

function policyFor(topic: string): TopicPolicy | undefined {
  let best: TopicPolicy | undefined;
  let bestLen = -1;
  for (const [prefix, policy] of policies) {
    if (prefix.length > bestLen && topic.startsWith(prefix)) {
      best = policy;
      bestLen = prefix.length;
    }
  }
  return best;
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  void stamps.ready().finally(() => {
    stampsSettled = true;
    schedule();
  });
  // The warm (and any stamp write) changes lastSyncedAt under published
  // snapshots; refresh them and let staleness re-evaluate.
  stamps.subscribe(() => {
    for (const [topic, rt] of topics) publish(topic, rt, rt.state.status);
    schedule();
  });
  onBootGateOpen(schedule);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", schedule);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", schedule);
    window.addEventListener("online", schedule);
  }
}

function paused(): boolean {
  if (!isBootGateOpen()) return true;
  if (!stampsSettled) return true;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return false;
}

function topicPriority(rt: TopicRuntime): SyncPriority {
  let best: SyncPriority = "prefetch";
  for (const w of rt.wants) {
    if (PRIORITY_RANK[w.priority] > PRIORITY_RANK[best]) best = w.priority;
  }
  return best;
}

/** When this topic is next allowed AND due to run. */
function dueAt(topic: string, rt: TopicRuntime, policy: TopicPolicy): number {
  if (rt.forced) return rt.nextEligibleAt;
  const stamp = stamps.get(topic) ?? 0;
  return Math.max(rt.nextEligibleAt, stamp + policy.staleAfterMs);
}

/**
 * The scheduler pass: start every due topic there is capacity for, answer
 * fresh-enough wants without a run, and arm one timer for the next deadline.
 * Idempotent; called on every state change and environment nudge.
 */
function schedule(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (paused()) return; // re-nudged by the gate / warm / visibility listeners

  const now = Date.now();
  let visibleRuns = 0;
  let deferredRuns = 0;
  for (const rt of topics.values()) {
    if (!rt.run) continue;
    if (rt.run.priority === "visible") visibleRuns++;
    else deferredRuns++;
  }

  interface Candidate {
    topic: string;
    rt: TopicRuntime;
    policy: TopicPolicy;
    priority: SyncPriority;
    at: number;
  }
  const candidates: Candidate[] = [];
  for (const [topic, rt] of topics) {
    if (rt.wants.size === 0 || rt.run) continue;
    const policy = policyFor(topic);
    if (!policy) continue;
    candidates.push({ topic, rt, policy, priority: topicPriority(rt), at: dueAt(topic, rt, policy) });
  }
  candidates.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.at - b.at);

  let nextWake = Infinity;
  for (const c of candidates) {
    if (c.at > now) {
      nextWake = Math.min(nextWake, c.at);
      // Fresh enough that no run is needed: that ANSWERS the want (an empty
      // store read is authoritative now). Leave error states standing until
      // the backoff deadline actually re-runs.
      if (c.rt.state.status === "idle" || c.rt.state.status === "pending") {
        if (stamps.get(c.topic) !== undefined) publish(c.topic, c.rt, "settled");
      }
      continue;
    }
    const visibleLane = c.priority === "visible";
    if (visibleLane ? visibleRuns >= MAX_VISIBLE_RUNS : deferredRuns >= MAX_DEFERRED_RUNS) {
      // Capacity-blocked; the finishing run's schedule() picks it up.
      publish(c.topic, c.rt, "pending");
      continue;
    }
    if (visibleLane) visibleRuns++;
    else deferredRuns++;
    startRun(c.topic, c.rt, c.policy, c.priority);
  }

  if (nextWake < Infinity) {
    timer = setTimeout(schedule, Math.max(MIN_WAKE_MS, nextWake - now));
  }
}

function startRun(topic: string, rt: TopicRuntime, policy: TopicPolicy, priority: SyncPriority): void {
  const controller = new AbortController();
  rt.run = { controller, priority };
  rt.forced = false;
  publish(topic, rt, "pending");
  policy.handler({ topic, signal: controller.signal }).then(
    () => finishRun(topic, rt, policy, true),
    () => finishRun(topic, rt, policy, false),
  );
}

function finishRun(topic: string, rt: TopicRuntime, policy: TopicPolicy, ok: boolean): void {
  const aborted = rt.run?.controller.signal.aborted ?? false;
  rt.run = undefined;
  if (aborted) {
    // Torn down mid-flight (last want released): neither an answer nor a
    // failure, and no stamp — the run may have stopped partway. The floor is
    // left alone so a remount's re-want isn't penalized a whole interval.
    publish(topic, rt, stamps.get(topic) === undefined ? "idle" : "settled");
  } else if (ok) {
    rt.failures = 0;
    rt.nextEligibleAt = Date.now() + policy.minIntervalMs;
    stamps.set(topic, Date.now());
    publish(topic, rt, "settled");
  } else {
    rt.failures++;
    // A zero min-interval must not mean a zero backoff: a persistently
    // failing handler with a standing want would hot-loop.
    const base = Math.max(policy.minIntervalMs, 1000);
    rt.nextEligibleAt = Date.now() + Math.min(base * 2 ** rt.failures, MAX_BACKOFF_MS);
    publish(topic, rt, "error");
  }
  schedule();
}

/**
 * Test seam: abort every run and drop all scheduler state, including
 * registered policies. Durable stamps live in KV and are cleared by the DB
 * purge / `resetKvCaches`, not here.
 */
export function _resetSyncManagerForTests(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  for (const rt of topics.values()) rt.run?.controller.abort();
  topics.clear();
  policies.clear();
}
