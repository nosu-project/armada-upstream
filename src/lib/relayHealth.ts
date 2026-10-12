/**
 * Which relays never complete a connection: a redirect (WebSockets don't follow
 * one), an HTML page where the relay was, a dead host. Every standing
 * consumer's round would otherwise re-dial it: a TLS handshake and a radio
 * wake each time, forever. After
 * {@link FAILURES_BEFORE_COOLDOWN} attempts in a row that closed without ever
 * opening, a relay is unreachable for a cooldown that doubles up to
 * {@link MAX_COOLDOWN_MS}; one successful open clears it. A running cooldown
 * is remembered across launches (localStorage, purged on logout), so a cold
 * start doesn't re-pay three attempts per dead relay before backing off.
 */
import { normalizeRelayUrl } from "@/lib/platform";

const FAILURES_BEFORE_COOLDOWN = 3;
const FIRST_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

interface Health {
  /** Consecutive attempts that closed without opening. */
  failures: number;
  /** The current attempt has opened. */
  opened: boolean;
  /** Unreachable until (ms), or 0. */
  until: number;
  timer?: ReturnType<typeof setTimeout>;
}

const health = new Map<string, Health>();
const STORAGE_KEY = "armada:relay-cooldowns";
let loaded = false;

/** Restore cooldowns still running from an earlier launch. */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Record<string, { until: number; failures: number }>) : {};
    const now = Date.now();
    for (const [key, { until, failures }] of Object.entries(stored)) {
      // A future stamp past the cap means the clock moved; don't trust it.
      if (!Number.isFinite(until) || until <= now || until > now + MAX_COOLDOWN_MS) continue;
      if (!Number.isInteger(failures) || failures < FAILURES_BEFORE_COOLDOWN) continue;
      if (health.has(key)) continue;
      health.set(key, { failures, opened: false, until, timer: setTimeout(emit, until - now) });
    }
  } catch { /* unreadable: start fresh */ }
}

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const now = Date.now();
    const out: Record<string, { until: number; failures: number }> = {};
    for (const [key, h] of health) if (h.until > now) out[key] = { until: h.until, failures: h.failures };
    if (Object.keys(out).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch { /* best effort */ }
}
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (url: string) => normalizeRelayUrl(url) ?? url;

function entry(url: string): Health {
  load();
  const key = keyOf(url);
  let h = health.get(key);
  if (!h) health.set(key, (h = { failures: 0, opened: false, until: 0 }));
  return h;
}

function emit(): void {
  version++;
  for (const l of [...listeners]) {
    try {
      l();
    } catch { /* a listener must never break the others */ }
  }
}

/** The relay's socket opened. */
export function noteRelayOpened(url: string): void {
  const h = entry(url);
  h.opened = true;
  const wasDown = h.until > 0;
  h.failures = 0;
  h.until = 0;
  clearTimeout(h.timer);
  if (wasDown) {
    persist();
    emit();
  }
}

/** The relay's socket closed; an attempt that never opened counts against it. */
export function noteRelayClosed(url: string, now = Date.now()): void {
  const h = entry(url);
  if (h.opened) {
    h.opened = false;
    return;
  }
  h.failures += 1;
  if (h.failures < FAILURES_BEFORE_COOLDOWN || h.until > now) return;
  const cooldown = Math.min(MAX_COOLDOWN_MS, FIRST_COOLDOWN_MS * 2 ** (h.failures - FAILURES_BEFORE_COOLDOWN));
  h.until = now + cooldown;
  clearTimeout(h.timer);
  // When the cooldown ends, consumers take the relay back and try it once more.
  h.timer = setTimeout(emit, cooldown);
  persist();
  emit();
}

/** Whether standing consumers should leave the relay alone for now. */
export function isRelayUnreachable(url: string, now = Date.now()): boolean {
  load();
  const h = health.get(keyOf(url));
  return h !== undefined && h.until > now;
}

/** Subscribe to a relay entering or leaving its cooldown. Returns an unsubscribe. */
export function onRelayHealthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps on every change, for `useSyncExternalStore`. */
export function relayHealthVersion(): number {
  return version;
}

/** Test seam. */
export function _resetRelayHealthForTests(): void {
  for (const h of health.values()) clearTimeout(h.timer);
  health.clear();
  listeners.clear();
  loaded = false;
}
