/**
 * Dev-only audit of every relay CONNECTION the pool opens and the code path
 * that first demanded it, for finding unconfigured relays. `NPool.open(url)`
 * runs synchronously in the first `relay()`/`group()` call, so the stack names
 * the caller. Toggle: `localStorage.debugNostr`; console: `__relayReport()`.
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

/** App-code frames only (drops the Error header, this module, pool internals). */
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
  // First frame past NostrProvider's open() is the caller that introduced the URL.
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

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__relayReport = relayReport;
}
