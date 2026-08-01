/**
 * Dev-only audit of every relay CONNECTION the pool opens, with the code path
 * that first demanded it — for hunting connections to relays the user never
 * configured (stale hints in nevents, authors' NIP-65 lists, peers' kind-10050
 * lists, hardcoded discovery sets, invite bootstrap dictionaries…).
 *
 * `NPool.open(url)` runs once per URL, synchronously inside the first
 * `pool.relay(url)` / `pool.group(urls)` call, so a stack captured here names
 * the hook/component that introduced the relay. Pool-routed traffic
 * (reqRouter) opens from inside the pool's request machinery instead; those
 * stacks are less specific, but those URLs come from the configured relay
 * sets, which are logged alongside — the mystery connections are the targeted
 * ones.
 *
 * Same toggle as the REQ log: `localStorage.debugNostr = '1'` (default on in
 * dev). Run `__relayReport()` in the console for the full table.
 */

let seq = 0;

interface OpenRecord {
  n: number;
  t: number;
  url: string;
  origin: string;
  stack: string;
}
const records: OpenRecord[] = [];

function enabled(): boolean {
  try {
    const v = localStorage.getItem("debugNostr");
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    /* localStorage may be unavailable */
  }
  return import.meta.env?.DEV ?? false;
}

/** Frames of the app's own code — drop the Error header, this module, the pool internals. */
function appFrames(stack: string): string[] {
  return stack
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) =>
      !l.includes("relayConnectionLog") &&
      !l.includes("node_modules") &&
      !l.includes("@nostrify"),
    );
}

/** Called from NPool's `open()` — the single place every pool socket is created. */
export function logRelayOpen(url: string): void {
  if (!enabled()) return;
  const stack = new Error().stack ?? "";
  const frames = appFrames(stack);
  // First frame past NostrProvider's open() itself is the caller that
  // introduced the URL (NostrBatcher's relay()/group() wrappers are app code
  // and useful context, so they stay in).
  const origin = frames.find((f) => !f.includes("NostrProvider")) ?? frames[0] ?? "(no stack)";
  const n = ++seq;
  records.push({ n, t: Date.now(), url, origin, stack });

  console.groupCollapsed(
    `%c[nostr OPEN #${n}]%c ${url}  %c${origin}`,
    "color:#e070ff;font-weight:bold",
    "color:inherit",
    "color:#9aa0a6",
  );
  console.log(stack);
  console.groupEnd();
}

/**
 * Print every relay connection opened so far with its origin. Call from the
 * console: __relayReport()
 */
function relayReport(): void {
  if (records.length === 0) {
    console.log("[relay report] no connections recorded yet");
    return;
  }
  console.log(
    `%c[relay report]%c ${records.length} relay connection(s) opened`,
    "color:#e070ff;font-weight:bold",
    "color:inherit",
  );
  console.table(records.map((r) => ({
    "#": r.n,
    at: new Date(r.t).toLocaleTimeString(),
    url: r.url,
    "opened by": r.origin,
  })));
  console.log("full stacks:", records);
}

// Expose on window for interactive use in dev.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__relayReport = relayReport;
}
