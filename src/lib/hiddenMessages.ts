/**
 * Viewer-local hidden messages: nothing published, per-account localStorage.
 * Complements block (NIP-51 mute) and delete (NIP-09). Capped; oldest drop first.
 */

const HIDDEN_LIMIT = 1000;

const storageKey = (pubkey: string) => `armada:hidden-messages:${pubkey}`;

const EMPTY: ReadonlySet<string> = new Set();

// Cached snapshot so `useSyncExternalStore` gets a stable reference between writes.
let cachedKey: string | null = null;
let cachedOrder: string[] = [];
let cachedIds: ReadonlySet<string> = EMPTY;

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function loadInto(key: string): void {
  cachedKey = key;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cachedOrder = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    cachedOrder = [];
  }
  cachedIds = new Set(cachedOrder);
}

function persist(key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(cachedOrder));
  } catch {
    // Storage unavailable — the hide survives for the session only.
  }
}

/** Hidden-message ids for one account. */
export function getHiddenMessageIds(pubkey: string | undefined): ReadonlySet<string> {
  if (!pubkey) return EMPTY;
  const key = storageKey(pubkey);
  if (cachedKey !== key) loadInto(key);
  return cachedIds;
}

export function hideMessageId(pubkey: string | undefined, id: string): void {
  if (!pubkey) return;
  const key = storageKey(pubkey);
  if (cachedKey !== key) loadInto(key);
  if (cachedIds.has(id)) return;
  cachedOrder = [...cachedOrder, id].slice(-HIDDEN_LIMIT);
  cachedIds = new Set(cachedOrder);
  persist(key);
  notify();
}

export function unhideMessageId(pubkey: string | undefined, id: string): void {
  if (!pubkey) return;
  const key = storageKey(pubkey);
  if (cachedKey !== key) loadInto(key);
  if (!cachedIds.has(id)) return;
  cachedOrder = cachedOrder.filter((v) => v !== id);
  cachedIds = new Set(cachedOrder);
  persist(key);
  notify();
}

export function subscribeHiddenMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
