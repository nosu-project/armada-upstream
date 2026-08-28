/**
 * Viewer-local hidden messages — "remove this post from my feed, now".
 *
 * Hiding is a statement about THIS viewer's screen, not about the network:
 * nothing is published, the author is never told, and no relay is asked to do
 * anything — which is exactly why it can be immediate and unconditional where
 * a delete request cannot. It complements the two person-level tools: block
 * (NIP-51 mute, hides everything from an author) and NIP-09 delete (the
 * author's own posts). Per-account localStorage, like the wallet and Esplora
 * prefs — a device-local view decision, not a synced document.
 *
 * The set is capped: hiding is for the message in front of you, not an
 * archive, and an unbounded set would grow with every hide forever. Oldest
 * entries fall off first.
 */

const HIDDEN_LIMIT = 1000;

const storageKey = (pubkey: string) => `armada:hidden-messages:${pubkey}`;

const EMPTY: ReadonlySet<string> = new Set();

// One cached snapshot per active key, so `useSyncExternalStore` gets a stable
// reference between writes (a re-parse per read would loop the store).
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

/** The hidden-message ids for one account. Stable reference between writes. */
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
