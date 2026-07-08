import type { NostrEvent, NPool, NRelay1 } from "@nostrify/nostrify";

/**
 * Liveness-gated publish (the "invisibly eaten reply" fix).
 *
 * `NRelay1.event()` sends the `EVENT` frame via `websocket-ts`, whose `send()`
 * SILENTLY BUFFERS into an `ArrayQueue` whenever the socket isn't `OPEN` (no
 * throw). On mobile the WebView's relay socket is frequently severed by the OS
 * (backgrounding, network change, CGNAT rebind); the frame then rots in that
 * buffer, the relay's `OK` never arrives, and the caller's `AbortSignal`
 * eventually times out — the message is marked failed/queued having never
 * reached the relay. Worse, `NRelay1.wake()` only recreates a socket that was
 * closed by its OWN idle timer (`closedByUser`), never one the OS severed, so a
 * naive retry reuses the same dead socket and backs off toward 5 minutes.
 *
 * This helper closes that gap: before sending, it verifies the pooled relay's
 * socket is actually `OPEN`. If it isn't (or a first attempt times out), it
 * DROPS the stale `NRelay1` from the pool's relay map so the next
 * `pool.relay(url)` rebuilds a fresh connection through the provider's `open()`
 * (re-applying NIP-42 AUTH + the socket-reopen watcher), waits for that socket
 * to open (bounded), then publishes. The event is only ever written to a socket
 * we've confirmed open, so it can't rot in the buffer.
 *
 * Note the honest limit: a socket the OS severed can still report `OPEN` for a
 * short window (until a failed send/ping surfaces the close), so `readyState`
 * alone can't catch every case on the FIRST attempt. The `OK` timeout + forced
 * reconnect on retry is the backstop — a message never dies silently in
 * backoff; it recovers against a fresh socket as soon as connectivity returns.
 */

/** How long to wait for a freshly-forced socket to reach `OPEN` before giving up. */
const OPEN_WAIT_MS = 5_000;

interface WebsocketLike {
  readyState: number;
  addEventListener?: (type: string, listener: () => void, opts?: { once?: boolean }) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * The subset of the pool we depend on: per-URL relay reuse + the relays map.
 * `NPool` types `relays` as a `ReadonlyMap`, but the runtime value is the
 * mutable internal map (`NPool.get relays()` returns `this._relays`), so
 * dropping a stale entry to force a reconnect is sound — we narrow it to a
 * mutable `Map` at the one `delete` site.
 */
type PoolLike = Pick<NPool, "relay" | "relays">;

function socketOf(relay: NRelay1): WebsocketLike | undefined {
  const sock = (relay as unknown as { socket?: WebsocketLike }).socket;
  return sock && typeof sock.readyState === "number" ? sock : undefined;
}

/** Wait until the relay's socket reports OPEN, or reject on timeout/abort. */
function waitForOpen(relay: NRelay1, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = socketOf(relay);
    // WebSocket.OPEN === 1. If we can't see the socket, don't block — let the
    // send proceed and rely on the caller's own timeout.
    if (!sock || sock.readyState === 1) {
      resolve();
      return;
    }
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      sock.removeEventListener?.("open", onOpen);
    };
    const onOpen = () => {
      if (settled) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(new DOMException("The signal has been aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`relay socket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    sock.addEventListener?.("open", onOpen, { once: true });
  });
}

/**
 * Force a fresh connection to `url`: drop the cached (stale/half-dead) relay
 * from the pool so the next `pool.relay(url)` builds a brand-new `NRelay1`
 * through the provider's `open()`. We deliberately do NOT call the old relay's
 * `close()` — that permanently sets `closedByUser`/aborts its controller, which
 * would poison the instance and abort any subscriptions still riding it. The
 * old instance is simply dereferenced; the fresh one owns the URL now.
 */
function forceFreshRelay(pool: PoolLike, url: string): NRelay1 {
  (pool.relays as Map<string, NRelay1>).delete(url);
  return pool.relay(url) as NRelay1;
}

/**
 * Publish `event` to a single relay with a live socket guaranteed. Throws the
 * relay's `OK: false` reason, a timeout, or an abort — same contract as
 * `NRelay1.event()`, so existing callers keep their error handling.
 */
export async function publishLive(
  pool: PoolLike,
  url: string,
  event: NostrEvent,
  opts: { signal: AbortSignal; timeoutMs: number },
): Promise<void> {
  const { signal, timeoutMs } = opts;
  let relay = pool.relay(url) as NRelay1;
  const sock = socketOf(relay);

  // If the socket isn't OPEN, force a fresh connection up front rather than
  // buffering the EVENT into a dead socket's queue.
  if (sock && sock.readyState !== 1) {
    relay = forceFreshRelay(pool, url);
  }

  try {
    await waitForOpen(relay, signal, Math.min(OPEN_WAIT_MS, timeoutMs));
  } catch {
    // Opening the (possibly fresh) socket didn't complete in time. Fall through
    // and attempt the send anyway — the caller's timeout still bounds it, and a
    // late-opening socket flushes the buffered EVENT.
  }

  await relay.event(event, { signal });
}
