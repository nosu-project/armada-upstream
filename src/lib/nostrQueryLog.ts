import type { NostrEvent, NostrFilter } from "@nostrify/types";

/**
 * Dev-only logging of every outgoing REQ and published event, to audit
 * redundant queries. Toggle with `localStorage.debugNostr = '1'|'0'` (on by
 * default in dev). Hooked into `NostrProvider`'s routers and
 * `NostrBatcher.wrapCaching`. Run `__nostrReport()` for a ranked summary.
 */

let seq = 0;
const seen = new Map<string, { count: number }>();

interface ReqRecord {
  n: number;
  t: number;
  via: string;
  relays: string[];
  filters: NostrFilter[];
  desc: string;
  sig: string;
}
const records: ReqRecord[] = [];

/** `debugNostr`, re-read at most once a second (a getItem per REQ showed up in boot profiles). */
let enabledCache: { value: boolean; at: number } | undefined;

function enabled(): boolean {
  const now = Date.now();
  if (enabledCache && now - enabledCache.at < 1000) return enabledCache.value;
  let value = import.meta.env?.DEV ?? false;
  try {
    const v = localStorage.getItem("debugNostr");
    if (v === "1" || v === "true") value = true;
    else if (v === "0" || v === "false") value = false;
  } catch {
    /* localStorage may be unavailable */
  }
  enabledCache = { value, at: now };
  return value;
}

/** Human-readable one-liner for a filter, e.g. `kinds[0] authors×3 limit20`. */
function describeFilter(f: NostrFilter): string {
  const parts: string[] = [];
  if (f.kinds) parts.push(`kinds[${f.kinds.join(",")}]`);
  if (f.ids) parts.push(`ids×${f.ids.length}`);
  if (f.authors) parts.push(`authors×${f.authors.length}`);
  for (const key of Object.keys(f)) {
    if (key.startsWith("#")) {
      const vals = (f as unknown as Record<string, unknown[]>)[key];
      parts.push(`${key}×${Array.isArray(vals) ? vals.length : "?"}`);
    }
  }
  if (typeof f.limit === "number") parts.push(`limit${f.limit}`);
  if (f.since) parts.push(`since${f.since}`);
  if (f.until) parts.push(`until${f.until}`);
  if ("search" in f) parts.push(`search=${(f as { search?: string }).search}`);
  return parts.join(" ") || "{}";
}

function describeFilters(filters: NostrFilter[]): string {
  return filters.map(describeFilter).join("  |  ");
}

/** Stable signature to detect duplicate queries fired repeatedly. */
function signature(relays: string[], filters: NostrFilter[]): string {
  const norm = filters.map((f) => {
    const e = Object.entries(f).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(e);
  });
  return `${[...relays].sort().join(",")}|${norm.join("|")}`;
}

export function logNostrReq(relays: string[], filters: NostrFilter[], via: string): void {
  if (!enabled()) return;
  const sig = signature(relays, filters);
  const prev = seen.get(sig);
  const dupCount = prev ? prev.count + 1 : 1;
  seen.set(sig, { count: dupCount });
  const n = ++seq;

  const desc = describeFilters(filters);
  records.push({ n, t: Date.now(), via, relays, filters, desc, sig });

  const flags: string[] = [];
  if (dupCount > 1) flags.push(`⟳x${dupCount} DUPLICATE`);
  if (relays.length === 0) flags.push("⚠ 0 RELAYS (dead query)");
  const flagNote = flags.length ? ` — ${flags.join(", ")}` : "";

  console.groupCollapsed(
    `%c[nostr REQ #${n}]%c ${via} → ${relays.length} relay(s)  %c${desc}%c${flagNote}`,
    "color:#4ea1ff;font-weight:bold",
    "color:inherit",
    "color:#9aa0a6",
    flags.length ? "color:#ff9800;font-weight:bold" : "color:inherit",
  );
  console.log("relays:", relays);
  console.log("raw filters:", filters);
  console.groupEnd();
}

export function logNostrEvent(relays: string[], event: NostrEvent): void {
  if (!enabled()) return;
  const n = ++seq;
  console.log(
    `%c[nostr EVENT #${n}]%c kind ${event.kind} → ${relays.length} relay(s)`,
    "color:#7ad67a;font-weight:bold",
    "color:inherit",
    { id: event.id.slice(0, 8), relays },
  );
}

/** Console `__nostrReport()`: REQs grouped by via + filter shape, with duplicates, zero-relay queries and per-kind counts. */
function nostrReport(): void {
  if (records.length === 0) {
    console.log("[nostr report] no REQs recorded yet");
    return;
  }

  const dupSigs = [...seen.entries()].filter(([, v]) => v.count > 1);
  const dupTotal = dupSigs.reduce((s, [, v]) => s + (v.count - 1), 0);
  const dead = records.filter((r) => r.relays.length === 0).length;
  console.log(
    `%c[nostr report]%c ${records.length} REQ(s) · ${dupSigs.length} query shape(s) repeated (${dupTotal} redundant re-fires) · ${dead} zero-relay query(s)`,
    "color:#4ea1ff;font-weight:bold",
    "color:inherit",
  );

  const bySig = new Map<string, { count: number; via: string; relays: string[]; desc: string }>();
  for (const r of records) {
    const e = bySig.get(r.sig);
    if (e) e.count++;
    else bySig.set(r.sig, { count: 1, via: r.via, relays: r.relays, desc: r.desc });
  }
  const dupRows = [...bySig.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      "×": e.count,
      via: e.via,
      relays: e.relays.length,
      filter: e.desc,
    }));
  console.log("%cIdentical queries (relays+filters), most repeated first:", "font-weight:bold");
  console.table(dupRows);

  const byVia = new Map<string, number>();
  for (const r of records) byVia.set(r.via, (byVia.get(r.via) ?? 0) + 1);
  console.log("%cBy scope (via):", "font-weight:bold");
  console.table([...byVia.entries()].sort((a, b) => b[1] - a[1]).map(([via, count]) => ({ via, count })));

  const byKind = new Map<number, number>();
  for (const r of records) {
    const kinds = new Set<number>();
    for (const f of r.filters) for (const k of f.kinds ?? []) kinds.add(k);
    for (const k of kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log("%cBy kind requested (REQs asking for each kind):", "font-weight:bold");
  console.table([...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, reqs]) => ({ kind, reqs })));
}

/** Reset the recorded log (e.g. before navigating to isolate a page's traffic). */
function nostrReportReset(): void {
  records.length = 0;
  seen.clear();
  seq = 0;
  console.log("[nostr report] reset");
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__nostrReport = nostrReport;
  (window as unknown as Record<string, unknown>).__nostrReportReset = nostrReportReset;
}
