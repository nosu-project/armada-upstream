/**
 * Steady-state profiler: what the app costs while it is just sitting there.
 *
 * `perf.ts` answers "why did boot take five seconds". This answers the other
 * complaint — fans spinning with the app idle, memory climbing over an
 * afternoon, a janky channel switch — and those are not boot questions. The
 * usual culprits each leave a different fingerprint, so each gets its own
 * instrument rather than one more line in the boot table:
 *
 *  - **Long frames** (Long Animation Frames where the engine has them, plain
 *    long tasks otherwise): main-thread time, ATTRIBUTED to the script entry
 *    point that spent it. Chromium only (Electron, Android WebView, Chrome);
 *    WebKit falls back to perf.ts's loop-lag sampler.
 *  - **Relay traffic**: every WebSocket, counted at the socket. Frames and
 *    bytes per relay, inbound events per kind, the live REQ count per relay,
 *    and REQs grouped by filter SHAPE — which is how a subscription that is
 *    torn down and re-opened on every render shows up (hundreds of REQs of one
 *    shape) next to one that is merely busy (one REQ, thousands of events).
 *  - **Timers**: live `setInterval`s by call site, and sampled `setTimeout` /
 *    `requestAnimationFrame` call sites. A polling loop or a rAF loop that
 *    never stops is the classic idle-CPU burn and costs nothing per call, so no
 *    long-frame instrument will ever see it.
 *  - **React commits**: counted always; per-component renders (and self time,
 *    in a profiling build) when switched on, because walking the committed
 *    tree is real work on a tree this size.
 *  - **Samples** every 10s: JS heap (Chromium), DOM node count, running
 *    infinite animations, open sockets and live REQs — the series a leak
 *    shows up in as a slope. The heap figure is `performance.memory`, which
 *    Chromium buckets and caches unless launched with
 *    `--enable-precise-memory-info`: without the flag a flat line is not
 *    evidence of no leak. The Memory panel's heap snapshots are the real test.
 *
 * PROFILING BUILDS ONLY: `npm run build:profile` and the perf harness
 * (`scripts/perf-profile.mjs`). Unlike perf.ts's counters, these probes patch
 * page globals, so a normal build never installs them — the `VITE_PROFILE`
 * checks fold to false and the bundler drops this module.
 *
 * Installed by `main.tsx` through `perfRuntimeInstall.ts`, a side-effect
 * import placed right after the polyfills, so the WebSocket and timer wrappers
 * are in place before any app module can create a socket or schedule
 * anything, and the React hook exists before react-dom evaluates and looks
 * for it.
 *
 * Read it in the console:
 *
 *   __armadaPerf.runtime()        // steady-state report
 *   __armadaPerf.runtime(true)    // same, then start a fresh window
 *   __armadaPerf.renders(true)    // attribute commits to components
 *   __armadaPerf.json()           // everything, as one pasteable JSON string
 *   __armadaPerf.reset()          // start a fresh window without printing
 *   await __armadaPerf.native()   // Android: the notification service's profile
 *
 * On a phone (a profiling build), Settings → Diagnostics copies the same JSON.
 *
 * The report names relay URLs (query strings stripped — LiveKit puts its token
 * there) and filter SHAPES (kinds and which keys are present, never the
 * pubkeys or ids in them). Message content is never recorded.
 */

import { Capacitor } from "@capacitor/core";

import { isDesktop } from "@/lib/desktop";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { hasNativeNotificationService } from "@/lib/platform";
import { perfReport, perfReset, type PerfReport } from "@/lib/perf";

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// ─── Aggregates ─────────────────────────────────────────────────────────────

interface Agg {
  count: number;
  total: number;
  max: number;
}

function addTo(map: Map<string, Agg>, key: string, ms = 0): Agg {
  let a = map.get(key);
  if (!a) {
    a = { count: 0, total: 0, max: 0 };
    map.set(key, a);
  }
  a.count += 1;
  a.total += ms;
  if (ms > a.max) a.max = ms;
  return a;
}

/** Everything that resets with the measurement window. */
const state = {
  windowStart: now(),
  hiddenMs: 0,
  hiddenSince: undefined as number | undefined,

  frameApi: "none" as "loaf" | "longtask" | "none",
  frames: { count: 0, total: 0, blocking: 0, max: 0, layout: 0 },
  scripts: new Map<string, Agg & { layout: number }>(),

  commits: 0,
  commitMs: 0,
  renders: new Map<string, { renders: number; mounts: number; selfMs: number; why: Map<string, number> }>(),

  timeoutCalls: 0,
  rafCalls: 0,
  timeoutSites: new Map<string, number>(),
  rafSites: new Map<string, number>(),
  intervalSites: new Map<string, number>(),

  eventsByKind: new Map<number, { count: number; bytes: number }>(),
  queries: new Map<string, { fetches: number; updates: number; observers: number }>(),
  shapes: new Map<string, { reqs: number; events: number; bytes: number; eose: number }>(),
};

function resetWindow(): void {
  state.windowStart = now();
  state.hiddenMs = 0;
  state.hiddenSince = typeof document !== "undefined" && document.hidden ? now() : undefined;
  state.frames = { count: 0, total: 0, blocking: 0, max: 0, layout: 0 };
  state.scripts.clear();
  state.commits = 0;
  state.commitMs = 0;
  state.renders.clear();
  state.timeoutCalls = 0;
  state.rafCalls = 0;
  state.timeoutSites.clear();
  state.rafSites.clear();
  state.intervalSites.clear();
  state.eventsByKind.clear();
  state.shapes.clear();
  state.queries.clear();
  for (const s of relays.values()) {
    const keep = { open: s.open, liveSubs: s.liveSubs, peakSubs: s.liveSubs };
    Object.assign(s, emptyRelayStats(), keep);
  }
  for (const rec of liveIntervals.values()) rec.fires = 0;
  // `samples` survive: a leak is a slope, and a reset should not cut it.
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * The first `depth` caller frames of a stack, below the `skip` frames that are
 * the instrument itself, with origins and cache-busting queries stripped so a
 * dev (`/src/lib/x.ts?t=…`) and a production (`/assets/index-abc.js`) site
 * both read as a path. Handles V8 (`at fn (url:1:2)`) and WebKit
 * (`fn@url:1:2`) frames.
 */
export function callSite(stack: string | undefined, skip = 1, depth = 2): string {
  if (!stack) return "?";
  const frames = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /:\d+:\d+\)?$/.test(l));
  const picked = frames.slice(skip, skip + depth).map((l) => scrubUrls(l.replace(/^at\s+/, "")));
  return picked.length > 0 ? picked.join(" < ") : "?";
}

/** Every URL in `text` reduced to its path: origins and queries dropped. */
export function scrubUrls(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^/)\s]*/gi, "").replace(/\?[^:)\s]*/g, "");
}

/**
 * A relay URL with its query and fragment dropped: LiveKit carries its access
 * token in the query, and a report is something the user pastes elsewhere.
 */
export function socketKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** A script URL as a bare path: the origin is the app's own and says nothing. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * A NIP-01 filter list reduced to its SHAPE: the kinds verbatim (they are the
 * interesting part and are not identifying), every other key by name and value
 * count. Two REQs with the same shape are "the same subscription" for the
 * purposes of spotting churn; the pubkeys and ids never leave the device.
 */
export function filterShape(filters: unknown[]): string {
  return filters
    .map((f) => {
      if (!f || typeof f !== "object") return "?";
      const parts: string[] = [];
      const rec = f as Record<string, unknown>;
      const kinds = rec.kinds;
      if (Array.isArray(kinds)) parts.push(`kinds:${[...kinds].sort((a, b) => Number(a) - Number(b)).join(",")}`);
      for (const key of Object.keys(rec).sort()) {
        if (key === "kinds") continue;
        const v = rec[key];
        parts.push(Array.isArray(v) ? `${key}×${v.length}` : key);
      }
      return `{${parts.join(" ")}}`;
    })
    .join(" ");
}

/** What an inbound or outbound Nostr frame is, from its head alone. */
export interface FrameHead {
  verb: string;
  sub?: string;
}

/**
 * Classify a relay frame without parsing it. Frames are JSON arrays whose
 * first element is the verb and, for everything subscription-scoped, whose
 * second is the subscription id — so a regex over the head is enough, and an
 * inbound EVENT (which may be megabytes) is never JSON-parsed twice.
 */
export function frameHead(data: string): FrameHead | undefined {
  const m = /^\s*\[\s*"([A-Z]+)"\s*(?:,\s*"((?:[^"\\]|\\.)*)")?/.exec(data.slice(0, 256));
  if (!m) return undefined;
  return m[2] === undefined ? { verb: m[1] } : { verb: m[1], sub: m[2] };
}

/**
 * The `kind` of an inbound EVENT frame. The literal `"kind":` can only be the
 * event's own key — inside `content` and tag values every quote is escaped.
 */
export function frameKind(data: string): number | undefined {
  const m = /"kind"\s*:\s*(\d+)/.exec(data);
  return m ? Number(m[1]) : undefined;
}

function sizeOf(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

// ─── Long frames ────────────────────────────────────────────────────────────

interface LoafScript {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}

function installFrameObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.includes("long-animation-frame")) {
    state.frameApi = "loaf";
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { blockingDuration?: number; scripts?: LoafScript[] };
        state.frames.count += 1;
        state.frames.total += e.duration;
        state.frames.blocking += e.blockingDuration ?? 0;
        if (e.duration > state.frames.max) state.frames.max = e.duration;
        for (const s of e.scripts ?? []) {
          const where = s.sourceURL ? `${pathOf(s.sourceURL)}:${s.sourceCharPosition ?? "?"}` : "";
          // A module-script's invoker IS its URL, cache-busting query and all.
          const key = [s.invokerType, s.invoker && scrubUrls(s.invoker), s.sourceFunctionName && `fn ${s.sourceFunctionName}`, where]
            .filter(Boolean)
            .join(" · ");
          const agg = addTo(state.scripts as Map<string, Agg>, key, s.duration) as Agg & { layout: number };
          agg.layout = (agg.layout ?? 0) + (s.forcedStyleAndLayoutDuration ?? 0);
          state.frames.layout += s.forcedStyleAndLayoutDuration ?? 0;
        }
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } else if (supported.includes("longtask")) {
    state.frameApi = "longtask";
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.frames.count += 1;
        state.frames.total += e.duration;
        state.frames.blocking += Math.max(0, e.duration - 50);
        if (e.duration > state.frames.max) state.frames.max = e.duration;
      }
    }).observe({ type: "longtask", buffered: true });
  }
}

// ─── WebSockets ─────────────────────────────────────────────────────────────

interface RelayStats {
  opened: number;
  open: number;
  framesIn: number;
  bytesIn: number;
  framesOut: number;
  bytesOut: number;
  reqs: number;
  closes: number;
  publishes: number;
  events: number;
  eose: number;
  closed: number;
  notices: number;
  auths: number;
  liveSubs: number;
  peakSubs: number;
}

function emptyRelayStats(): RelayStats {
  return {
    opened: 0, open: 0, framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0,
    reqs: 0, closes: 0, publishes: 0, events: 0, eose: 0, closed: 0,
    notices: 0, auths: 0, liveSubs: 0, peakSubs: 0,
  };
}

/** Per relay URL (query stripped), summed across reconnects. */
const relays = new Map<string, RelayStats>();

/** Per live socket: its subscriptions, by id, with the shape each was opened with. */
const socketSubs = new WeakMap<WebSocket, Map<string, string>>();
const socketKeys = new WeakMap<WebSocket, string>();

function relayStats(key: string): RelayStats {
  let s = relays.get(key);
  if (!s) {
    s = emptyRelayStats();
    relays.set(key, s);
  }
  return s;
}

function subsOf(ws: WebSocket): Map<string, string> {
  let m = socketSubs.get(ws);
  if (!m) {
    m = new Map();
    socketSubs.set(ws, m);
  }
  return m;
}

function shapeAgg(shape: string) {
  let a = state.shapes.get(shape);
  if (!a) {
    a = { reqs: 0, events: 0, bytes: 0, eose: 0 };
    state.shapes.set(shape, a);
  }
  return a;
}

function dropSub(ws: WebSocket, stats: RelayStats, sub: string): void {
  if (subsOf(ws).delete(sub)) stats.liveSubs = Math.max(0, stats.liveSubs - 1);
}

function onOutbound(ws: WebSocket, data: unknown): void {
  const key = socketKeys.get(ws);
  if (!key) return;
  const stats = relayStats(key);
  stats.framesOut += 1;
  stats.bytesOut += sizeOf(data);
  if (typeof data !== "string") return;
  const head = frameHead(data);
  if (!head) return;
  switch (head.verb) {
    case "REQ": {
      stats.reqs += 1;
      let shape = "?";
      try {
        shape = filterShape((JSON.parse(data) as unknown[]).slice(2));
      } catch {
        // unparseable REQ — still counted, as "?"
      }
      shapeAgg(shape).reqs += 1;
      if (head.sub !== undefined) {
        const subs = subsOf(ws);
        // A REQ reusing a live id REPLACES that subscription (NIP-01).
        if (!subs.has(head.sub)) {
          stats.liveSubs += 1;
          if (stats.liveSubs > stats.peakSubs) stats.peakSubs = stats.liveSubs;
        }
        subs.set(head.sub, shape);
      }
      break;
    }
    case "CLOSE":
      stats.closes += 1;
      if (head.sub !== undefined) dropSub(ws, stats, head.sub);
      break;
    case "EVENT":
      stats.publishes += 1;
      break;
    case "AUTH":
      stats.auths += 1;
      break;
  }
}

function onInbound(ws: WebSocket, data: unknown): void {
  const key = socketKeys.get(ws);
  if (!key) return;
  const stats = relayStats(key);
  const bytes = sizeOf(data);
  stats.framesIn += 1;
  stats.bytesIn += bytes;
  if (typeof data !== "string") return;
  const head = frameHead(data);
  if (!head) return;
  switch (head.verb) {
    case "EVENT": {
      stats.events += 1;
      const kind = frameKind(data);
      if (kind !== undefined) {
        let k = state.eventsByKind.get(kind);
        if (!k) {
          k = { count: 0, bytes: 0 };
          state.eventsByKind.set(kind, k);
        }
        k.count += 1;
        k.bytes += bytes;
      }
      const shape = head.sub !== undefined ? subsOf(ws).get(head.sub) : undefined;
      if (shape !== undefined) {
        const a = shapeAgg(shape);
        a.events += 1;
        a.bytes += bytes;
      }
      break;
    }
    case "EOSE": {
      stats.eose += 1;
      const shape = head.sub !== undefined ? subsOf(ws).get(head.sub) : undefined;
      if (shape !== undefined) shapeAgg(shape).eose += 1;
      break;
    }
    case "CLOSED":
      stats.closed += 1;
      if (head.sub !== undefined) dropSub(ws, stats, head.sub);
      break;
    case "NOTICE":
      stats.notices += 1;
      break;
  }
}

function installWebSocketProbe(): void {
  if (typeof WebSocket === "undefined") return;
  const Native = WebSocket;
  const nativeSend = Native.prototype.send;
  Native.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    try {
      onOutbound(this, data);
    } catch {
      // the instrument must never break a send
    }
    return nativeSend.call(this, data);
  };

  class ProfiledWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const key = socketKey(String(url));
      socketKeys.set(this, key);
      const stats = relayStats(key);
      stats.opened += 1;
      // `open` counts sockets that got there; a failed dial never did.
      let isOpen = false;
      this.addEventListener("open", () => {
        isOpen = true;
        stats.open += 1;
      });
      this.addEventListener("message", (ev) => {
        try {
          onInbound(this, (ev as MessageEvent).data);
        } catch {
          // never break a receive
        }
      });
      this.addEventListener("close", () => {
        const subs = socketSubs.get(this);
        if (subs) {
          stats.liveSubs = Math.max(0, stats.liveSubs - subs.size);
          socketSubs.delete(this);
        }
        if (isOpen) {
          isOpen = false;
          stats.open = Math.max(0, stats.open - 1);
        }
      });
    }
  }
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ProfiledWebSocket;
}

// ─── Timers ─────────────────────────────────────────────────────────────────

/** 1 in SAMPLE_EVERY setTimeout/rAF calls captures a stack. */
const SAMPLE_EVERY = 32;

const liveIntervals = new Map<number, { site: string; ms: number; fires: number }>();

function installTimerProbe(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const nativeRaf = window.requestAnimationFrame;

  w.setTimeout = function (handler: TimerHandler, timeout?: number, ...args: unknown[]) {
    state.timeoutCalls += 1;
    if (state.timeoutCalls % SAMPLE_EVERY === 0) {
      const site = callSite(new Error().stack);
      state.timeoutSites.set(site, (state.timeoutSites.get(site) ?? 0) + 1);
    }
    return nativeSetTimeout.call(window, handler, timeout, ...args);
  };

  w.setInterval = function (handler: TimerHandler, timeout?: number, ...args: unknown[]) {
    const site = callSite(new Error().stack);
    state.intervalSites.set(site, (state.intervalSites.get(site) ?? 0) + 1);
    const rec = { site, ms: Number(timeout) || 0, fires: 0 };
    const wrapped: TimerHandler =
      typeof handler === "function"
        ? function (this: unknown, ...a: unknown[]) {
            rec.fires += 1;
            return (handler as (...x: unknown[]) => unknown).apply(this, a);
          }
        : handler;
    const id = nativeSetInterval.call(window, wrapped, timeout, ...args);
    liveIntervals.set(id, rec);
    return id;
  };

  // Timeout and interval ids share one pool, and either clear works on both.
  w.clearInterval = function (id?: number) {
    if (id !== undefined) liveIntervals.delete(id);
    return nativeClearInterval.call(window, id);
  };
  w.clearTimeout = function (id?: number) {
    if (id !== undefined) liveIntervals.delete(id);
    return nativeClearTimeout.call(window, id);
  };

  if (typeof nativeRaf === "function") {
    w.requestAnimationFrame = function (cb: FrameRequestCallback) {
      state.rafCalls += 1;
      if (state.rafCalls % SAMPLE_EVERY === 0) {
        const site = callSite(new Error().stack);
        state.rafSites.set(site, (state.rafSites.get(site) ?? 0) + 1);
      }
      return nativeRaf.call(window, cb);
    };
  }
}

// ─── React Query ────────────────────────────────────────────────────────────

/**
 * A query key reduced to its FAMILY: ids (anything hex-like or long) become
 * `…`, so a channel's timeline and another channel's timeline count together
 * and no id lands in a pasted report.
 */
export function queryFamily(key: readonly unknown[]): string {
  return key
    .slice(0, 4)
    .map((part) => {
      if (typeof part === "string") return /^[0-9a-f]{16,}$/i.test(part) || part.length > 24 ? "…" : part;
      if (part === null || part === undefined || typeof part === "number" || typeof part === "boolean") return String(part);
      return "{…}";
    })
    .join("/");
}

/** The slice of a TanStack QueryCache this reads. */
interface QueryCacheLike {
  subscribe(listener: (event: {
    type: string;
    query: { queryKey: readonly unknown[] };
    action?: { type: string };
  }) => void): () => void;
}

/**
 * Count, per query family, how often it FETCHES and how often its data is
 * replaced (`success` actions — each one notifies every observer, which is a
 * render of every component reading it). A family that fetches on every
 * render, or whose data is replaced far more often than anything changes, is
 * the "idle CPU with nothing on the wire" signature.
 */
export function instrumentQueryCache(cache: QueryCacheLike): () => void {
  return cache.subscribe((event) => {
    if (event.type === "observerAdded") {
      entry(queryFamily(event.query.queryKey)).observers += 1;
      return;
    }
    if (event.type !== "updated" || !event.action) return;
    if (event.action.type === "fetch") entry(queryFamily(event.query.queryKey)).fetches += 1;
    else if (event.action.type === "success") entry(queryFamily(event.query.queryKey)).updates += 1;
  });
  function entry(family: string) {
    let e = state.queries.get(family);
    if (!e) {
      e = { fetches: 0, updates: 0, observers: 0 };
      state.queries.set(family, e);
    }
    return e;
  }
}

// ─── React ──────────────────────────────────────────────────────────────────

/** The slice of a React Fiber this reads. Internal, but stable since 16. */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  actualDuration?: number;
  selfBaseDuration?: number;
  memoizedProps?: unknown;
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
/** `PerformedWork`: the component's render function actually ran this commit. */
const PERFORMED_WORK = 1;

let renderTracking = import.meta.env.VITE_PROFILE === "1";

function nameOf(t: unknown): string | undefined {
  if (!t || (typeof t !== "function" && typeof t !== "object")) return undefined;
  const r = t as { displayName?: string; name?: string };
  return r.displayName || r.name || undefined;
}

export function fiberName(f: Pick<Fiber, "tag" | "type">): string | undefined {
  switch (f.tag) {
    case FUNCTION_COMPONENT:
    case CLASS_COMPONENT:
    case SIMPLE_MEMO_COMPONENT:
      return nameOf(f.type) ?? "Anonymous";
    case FORWARD_REF: {
      const t = f.type as { displayName?: string; render?: unknown } | null;
      return t?.displayName || nameOf(t?.render) || "ForwardRef";
    }
    default:
      return undefined;
  }
}

/**
 * Why a component that was already mounted rendered again: the props whose
 * identity changed since its last commit. Names a memo'd row whose parent
 * hands it a fresh callback every render. Empty when no prop changed — see
 * {@link renderCause} for what it falls back to.
 */
export function changedProps(prev: unknown, next: unknown): string[] {
  if (prev === next || !prev || !next || typeof prev !== "object" || typeof next !== "object") {
    return prev === next ? [] : ["(props)"];
  }
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "children" && !Object.is(a[key], b[key])) changed.push(key);
  }
  if (changed.length === 0 && !Object.is(a.children, b.children)) changed.push("children");
  return changed;
}

/** A function component's hook list node (React internals; stable since 16.8). */
interface HookNode {
  memoizedState: unknown;
  queue: unknown;
  next: HookNode | null;
}

/** One context a fiber read during its last render. */
interface ContextDependency {
  context: { displayName?: string };
  memoizedValue: unknown;
  next: ContextDependency | null;
}

type HookedFiber = Pick<Fiber, "tag" | "memoizedProps"> & {
  memoizedState?: unknown;
  dependencies?: { firstContext: ContextDependency | null } | null;
};

/**
 * The hooks and contexts whose values changed between two renders of a
 * function component, by position: `ctx:<displayName>` for a context,
 * `query#n` for a stateful hook holding a React Query result (useQuery's
 * external store), `state#n` for any other useState/useReducer/store hook —
 * `n` counting stateful hooks only, in call order. Effects and memos are
 * skipped: their slots are rebuilt on every render and say nothing about why.
 */
export function changedHooks(prev: HookedFiber, next: HookedFiber): string[] {
  const out: string[] = [];
  let a = prev.dependencies?.firstContext ?? null;
  let b = next.dependencies?.firstContext ?? null;
  while (a && b) {
    if (a.context === b.context && !Object.is(a.memoizedValue, b.memoizedValue)) {
      out.push(`ctx:${b.context.displayName ?? shapeOf(b.memoizedValue)}`);
    }
    a = a.next;
    b = b.next;
  }
  if (next.tag === CLASS_COMPONENT) return out;
  let h = prev.memoizedState as HookNode | null | undefined;
  let k = next.memoizedState as HookNode | null | undefined;
  let n = 0;
  while (h && k && typeof h === "object" && typeof k === "object" && "next" in k) {
    if (k.queue !== null && k.queue !== undefined) {
      if (!Object.is(h.memoizedState, k.memoizedState)) {
        const v = k.memoizedState;
        out.push(v && typeof v === "object" && "fetchStatus" in v ? `query#${n}` : `state#${n}`);
      }
      n += 1;
    }
    h = h.next;
    k = k.next;
  }
  return out;
}

/** An unnamed context, by the first keys of its value: `{config,updateConfig,…}`. */
function shapeOf(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  return `{${keys.slice(0, 3).join(",")}${keys.length > 3 ? ",…" : ""}}`;
}

/**
 * Everything {@link walkCommit} can say about why a mounted component rendered:
 * changed props, else changed hooks/contexts, else `(parent)` — a new props
 * object with nothing in it changed, i.e. an unmemoized child of a component
 * that rendered — or `(unknown)`.
 */
export function renderCause(prev: HookedFiber, next: HookedFiber): string[] {
  const props = changedProps(prev.memoizedProps, next.memoizedProps);
  if (props.length > 0) return props;
  const hooks = changedHooks(prev, next);
  if (hooks.length > 0) return hooks;
  return [prev.memoizedProps === next.memoizedProps ? "(unknown)" : "(parent)"];
}

/**
 * Attribute one commit to the components that rendered in it. A subtree React
 * bailed out of keeps its PREVIOUS child pointer (`child === alternate.child`),
 * so it is skipped whole — the walk costs what the commit re-rendered, not the
 * size of the tree.
 */
export function walkCommit(
  rootFiber: Fiber | null,
  record: (name: string, mount: boolean, selfMs: number, why?: string[]) => void,
): void {
  const stack: Fiber[] = [];
  if (rootFiber) stack.push(rootFiber);
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.sibling) stack.push(f.sibling);
    const mount = f.alternate === null;
    if (mount || (f.flags & PERFORMED_WORK) !== 0) {
      const name = fiberName(f);
      if (name) {
        record(
          name,
          mount,
          typeof f.selfBaseDuration === "number" ? f.selfBaseDuration : 0,
          mount ? undefined : renderCause(f.alternate! as HookedFiber, f as HookedFiber),
        );
      }
    }
    if (f.child && (mount || f.child !== f.alternate!.child)) stack.push(f.child);
  }
}

function installReactHook(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown> };
  let hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    // No DevTools extension and no React Refresh (i.e. production): stand in
    // for the hook react-dom looks for when it first evaluates.
    let nextId = 1;
    hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject: () => nextId++,
      onCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      setStrictMode: () => {},
      checkDCE: () => {},
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }
  const prev = hook.onCommitFiberRoot as ((...a: unknown[]) => unknown) | undefined;
  hook.onCommitFiberRoot = function (this: unknown, id: unknown, root: { current: Fiber }, ...rest: unknown[]) {
    try {
      state.commits += 1;
      const d = root.current.actualDuration;
      if (typeof d === "number") state.commitMs += d;
      if (renderTracking) {
        walkCommit(root.current.child, (name, mount, selfMs, why) => {
          let r = state.renders.get(name);
          if (!r) {
            r = { renders: 0, mounts: 0, selfMs: 0, why: new Map() };
            state.renders.set(name, r);
          }
          if (mount) r.mounts += 1;
          else r.renders += 1;
          r.selfMs += selfMs;
          for (const key of why ?? []) r.why.set(key, (r.why.get(key) ?? 0) + 1);
        });
      }
    } catch {
      // DevTools internals are not API; a shape change must cost the report,
      // never the commit.
    }
    return prev?.call(this, id, root, ...rest);
  };
}

/** Switch per-component render attribution on or off. */
export function setRenderTracking(on: boolean): void {
  renderTracking = on;
}

export function isRenderTracking(): boolean {
  return renderTracking;
}

// ─── Samples ────────────────────────────────────────────────────────────────

const SAMPLE_MS = 10_000;
/** One hour at 10s. */
const MAX_SAMPLES = 360;

interface Sample {
  /** Seconds since page load. */
  t: number;
  hidden: boolean;
  heapMB?: number;
  domNodes: number;
  animations: number;
  sockets: number;
  liveSubs: number;
  intervals: number;
}

const samples: Sample[] = [];

function heapMB(): number | undefined {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : undefined;
}

/** Infinite animations currently running — the ones that cost frames forever. */
function runningAnimations(): { name: string; target: string }[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  const out: { name: string; target: string }[] = [];
  for (const a of document.getAnimations()) {
    if (a.playState !== "running") continue;
    const timing = a.effect?.getComputedTiming();
    if (timing?.iterations !== Infinity) continue;
    const name = (a as Animation & { animationName?: string }).animationName || a.id || "animation";
    const el = (a.effect as KeyframeEffect | null)?.target as Element | null | undefined;
    const target = el
      ? `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : ""}`
      : "?";
    out.push({ name, target });
  }
  return out;
}

function takeSample(): void {
  let sockets = 0;
  let liveSubs = 0;
  for (const s of relays.values()) {
    sockets += s.open;
    liveSubs += s.liveSubs;
  }
  samples.push({
    t: Math.round(now() / 1000),
    hidden: typeof document !== "undefined" && document.hidden,
    heapMB: heapMB(),
    domNodes: typeof document !== "undefined" ? document.getElementsByTagName("*").length : 0,
    animations: runningAnimations().length,
    sockets,
    liveSubs,
    intervals: liveIntervals.size,
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

// ─── Report ─────────────────────────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function top<T>(entries: T[], by: (t: T) => number, n: number): T[] {
  return entries.sort((a, b) => by(b) - by(a)).slice(0, n);
}

export interface RuntimeReport {
  windowSec: number;
  hiddenSec: number;
  frames: {
    api: "loaf" | "longtask" | "none";
    count: number;
    totalMs: number;
    blockingMs: number;
    maxMs: number;
    forcedLayoutMs: number;
    /** Share of the window's wall clock spent in long frames. */
    busyPct: number;
    scripts: { site: string; count: number; totalMs: number; maxMs: number; layoutMs: number }[];
  };
  react: {
    commits: number;
    commitsPerMin: number;
    /** Only in a profiling build (`npm run build:profile`). */
    commitMs?: number;
    renderTracking: boolean;
    /** `why`: what changed on a re-render, most frequent first (see {@link renderCause}). */
    components: { name: string; renders: number; mounts: number; selfMs: number; why: string }[];
  };
  timers: {
    setTimeoutPerSec: number;
    rafPerSec: number;
    liveIntervals: { site: string; ms: number; fires: number }[];
    intervalsCreated: { site: string; count: number }[];
    timeoutSites: { site: string; estCalls: number }[];
    rafSites: { site: string; estCalls: number }[];
  };
  relays: ({ url: string } & RelayStats)[];
  eventsByKind: { kind: number; count: number; bytes: number }[];
  /** Per query family: fetches, data replacements, observers added (see {@link instrumentQueryCache}). */
  queries: { family: string; fetches: number; updates: number; observers: number }[];
  reqShapes: { shape: string; reqs: number; events: number; bytes: number; eose: number }[];
  animations: { name: string; target: string; count: number }[];
  samples: Sample[];
}

export function runtimeReport(): RuntimeReport {
  const t = now();
  const windowMs = Math.max(1, t - state.windowStart);
  const hiddenMs = state.hiddenMs + (state.hiddenSince !== undefined ? t - state.hiddenSince : 0);
  const perSec = (n: number) => r1(n / (windowMs / 1000));

  const anims = new Map<string, { name: string; target: string; count: number }>();
  for (const a of runningAnimations()) {
    const k = `${a.name} ${a.target}`;
    const e = anims.get(k);
    if (e) e.count += 1;
    else anims.set(k, { ...a, count: 1 });
  }

  return {
    windowSec: Math.round(windowMs / 1000),
    hiddenSec: Math.round(hiddenMs / 1000),
    frames: {
      api: state.frameApi,
      count: state.frames.count,
      totalMs: Math.round(state.frames.total),
      blockingMs: Math.round(state.frames.blocking),
      maxMs: Math.round(state.frames.max),
      forcedLayoutMs: Math.round(state.frames.layout),
      busyPct: r1((state.frames.total / windowMs) * 100),
      scripts: top(
        [...state.scripts.entries()].map(([site, a]) => ({
          site,
          count: a.count,
          totalMs: Math.round(a.total),
          maxMs: Math.round(a.max),
          layoutMs: Math.round(a.layout ?? 0),
        })),
        (s) => s.totalMs,
        40,
      ),
    },
    react: {
      commits: state.commits,
      commitsPerMin: r1(state.commits / (windowMs / 60000)),
      ...(state.commitMs > 0 ? { commitMs: Math.round(state.commitMs) } : {}),
      renderTracking,
      components: top(
        [...state.renders.entries()].map(([name, r]) => ({
          name,
          renders: r.renders,
          mounts: r.mounts,
          selfMs: r1(r.selfMs),
          why: [...r.why.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .map(([k, n]) => `${k}×${n}`)
            .join(" "),
        })),
        (c) => (c.selfMs > 0 ? c.selfMs : c.renders + c.mounts),
        60,
      ),
    },
    timers: {
      setTimeoutPerSec: perSec(state.timeoutCalls),
      rafPerSec: perSec(state.rafCalls),
      liveIntervals: top([...liveIntervals.values()].map((i) => ({ ...i })), (i) => i.fires, 40),
      intervalsCreated: top(
        [...state.intervalSites.entries()].map(([site, count]) => ({ site, count })),
        (s) => s.count,
        20,
      ),
      timeoutSites: top(
        [...state.timeoutSites.entries()].map(([site, n]) => ({ site, estCalls: n * SAMPLE_EVERY })),
        (s) => s.estCalls,
        30,
      ),
      rafSites: top(
        [...state.rafSites.entries()].map(([site, n]) => ({ site, estCalls: n * SAMPLE_EVERY })),
        (s) => s.estCalls,
        15,
      ),
    },
    relays: top(
      [...relays.entries()].map(([url, s]) => ({ url, ...s })),
      (r) => r.bytesIn + r.bytesOut,
      60,
    ),
    eventsByKind: top(
      [...state.eventsByKind.entries()].map(([kind, k]) => ({ kind, ...k })),
      (k) => k.count,
      40,
    ),
    queries: top(
      [...state.queries.entries()].map(([family, q]) => ({ family, ...q })),
      (q) => q.fetches + q.updates,
      40,
    ),
    reqShapes: top(
      [...state.shapes.entries()].map(([shape, a]) => ({ shape, ...a })),
      (a) => a.reqs * 1000 + a.events,
      40,
    ),
    animations: [...anims.values()].sort((a, b) => b.count - a.count),
    samples: samples.map((s) => ({ ...s })),
  };
}

/** Everything, with enough context to read it on another machine. */
export interface FullPerfReport {
  generatedAt: string;
  build: { version: string; commit: string; profile: boolean };
  platform: string;
  userAgent: string;
  cores?: number;
  boot: PerfReport;
  runtime: RuntimeReport;
}

export function fullPerfReport(): FullPerfReport {
  const platform = isDesktop() ? "desktop" : Capacitor.getPlatform();
  return {
    generatedAt: new Date().toISOString(),
    build: {
      version: import.meta.env.VERSION,
      commit: import.meta.env.COMMIT_SHA,
      profile: import.meta.env.VITE_PROFILE === "1",
    },
    platform,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    cores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
    boot: perfReport(),
    runtime: runtimeReport(),
  };
}

/**
 * The Android notification service's own profile (a separate component with
 * its own counters: ServiceProfiler.java), when this is a native build whose
 * APK was also built for profiling. Undefined anywhere else.
 */
export async function nativeServiceProfile(): Promise<Record<string, unknown> | undefined> {
  if (!hasNativeNotificationService()) return undefined;
  try {
    return (await ArmadaNotification.getHealth()).profile;
  } catch {
    return undefined;
  }
}

/** Start a fresh measurement window (both the runtime counters and perf.ts's aggregates). */
export function resetRuntimeProfile(): void {
  resetWindow();
  perfReset();
}

function printRuntime(reset = false): RuntimeReport {
  const r = runtimeReport();
  const h = (s: string) => console.log(`— ${s} —`);
  console.log(
    `%c[armada perf: runtime]%c ${r.windowSec}s window (${r.hiddenSec}s hidden)`,
    "color:#c586ff;font-weight:bold",
    "color:inherit",
  );
  h(`long frames (${r.frames.api}): ${r.frames.count} frames, ${r.frames.totalMs}ms, ${r.frames.busyPct}% of wall clock, blocking ${r.frames.blockingMs}ms, forced layout ${r.frames.forcedLayoutMs}ms`);
  if (r.frames.scripts.length) console.table(r.frames.scripts);
  h(`react: ${r.react.commits} commits (${r.react.commitsPerMin}/min)${r.react.commitMs !== undefined ? `, ${r.react.commitMs}ms rendering` : ""}${r.react.renderTracking ? "" : " — per-component off, __armadaPerf.renders(true)"}`);
  if (r.react.components.length) console.table(r.react.components);
  h(`timers: setTimeout ${r.timers.setTimeoutPerSec}/s, rAF ${r.timers.rafPerSec}/s, ${r.timers.liveIntervals.length} live intervals`);
  if (r.timers.liveIntervals.length) console.table(r.timers.liveIntervals);
  if (r.timers.timeoutSites.length) console.table(r.timers.timeoutSites);
  if (r.timers.rafSites.length) console.table(r.timers.rafSites);
  h("relays");
  console.table(r.relays);
  h("react-query families (fetches / data replacements / observers added)");
  console.table(r.queries);
  h("inbound events by kind");
  console.table(r.eventsByKind);
  h("REQs by filter shape");
  console.table(r.reqShapes);
  if (r.animations.length) {
    h("running infinite animations");
    console.table(r.animations);
  }
  h("samples (every 10s)");
  console.table(r.samples.slice(-30));
  if (reset) resetRuntimeProfile();
  return r;
}

// ─── Install ────────────────────────────────────────────────────────────────

let installed = false;

/**
 * Install every probe. Idempotent. Must run before react-dom evaluates and
 * before anything opens a socket — which is why it is called from
 * `perfRuntimeInstall.ts`, imported by `main.tsx` right after the polyfills,
 * and never as a side effect of importing THIS module (Settings imports it,
 * and so do tests, neither of which should patch the globals).
 */
export function installRuntimeProfiler(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // a probe the engine doesn't support is a gap in the report, not a crash
    }
  };
  guard(installFrameObserver);
  guard(installWebSocketProbe);
  guard(installTimerProbe);
  guard(installReactHook);

  if (typeof document !== "undefined") {
    state.hiddenSince = document.hidden ? now() : undefined;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) state.hiddenSince = now();
      else if (state.hiddenSince !== undefined) {
        state.hiddenMs += now() - state.hiddenSince;
        state.hiddenSince = undefined;
      }
    });
  }
  // The sampler's own timer is scheduled through the patched setInterval, so
  // it shows in the report as one live 10s interval — a known baseline.
  window.setInterval(takeSample, SAMPLE_MS);

  const reader = (window as unknown as { __armadaPerf?: Record<string, unknown> }).__armadaPerf;
  if (reader) {
    reader.runtime = printRuntime;
    reader.renders = (on = true) => {
      setRenderTracking(on);
      return on;
    };
    reader.json = () => JSON.stringify(fullPerfReport(), null, 2);
    reader.reset = resetRuntimeProfile;
    reader.native = nativeServiceProfile;
  }
}
