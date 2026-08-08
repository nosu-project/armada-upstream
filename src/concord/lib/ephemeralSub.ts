/**
 * One standing kind-21059 REQ per relay, merged across channels.
 *
 * Four hooks tail the ephemeral wraps of a channel's current stream address —
 * voice presence, voice reactions, typing, webxdc realtime — and the sidebar
 * mounts the presence hook for EVERY channel row, so the per-hook `req()` loop
 * opened one socket REQ per (channel, relay): a measured boot paid 36 REQs of
 * `kinds[21059] authors×1` back to back. Every channel's stream address is a
 * distinct derived pubkey, so NostrBatcher's identical-filter coalescing can
 * never merge them; the merge has to happen where the authors are known
 * together, which is here. Subscribers register (relay, author, handler); each
 * relay carries ONE REQ with `authors×N`, reopened — debounced, so a mounting
 * sidebar contributes one reopen, not eighteen — whenever the author set
 * changes, and events demux by `event.pubkey`: the ephemeral wrap's signer IS
 * the stream address the filter asked for.
 *
 * Ephemeral wraps are never stored (NIP-01 kind range; `cacheEvents` refuses
 * wraps besides), so there is no replay to miss across a reopen — anything
 * lost in the gap is a heartbeat the next interval resends.
 */
import { KIND_WRAP_EPHEMERAL } from "@/concord/lib/kinds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** What this module needs of the app's Nostr client. */
interface EphemeralNostr {
  relay(url: string): {
    req(
      filters: NostrFilter[],
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<unknown[]>;
  };
}

type Handler = (event: NostrEvent) => void;

interface RelayLine {
  /** Stream author pk → the handlers that want its ephemeral wraps. */
  authors: Map<string, Set<Handler>>;
  /** The REQ currently open, if any. */
  controller?: AbortController;
  /** Sorted author set the open REQ was built from, to skip no-op reopens. */
  openedAuthors: string;
  /** Debounce for reopening after a burst of (un)subscribes. */
  timer?: ReturnType<typeof setTimeout>;
}

const lines = new Map<string, RelayLine>();

/** How long a (un)subscribe burst may grow before the REQ is (re)opened. */
const REOPEN_MS = 50;

/**
 * Tail the ephemeral wraps authored by `author` (a channel's current stream
 * pk) on `relay`. Returns an unsubscribe. Handlers receive the raw 21059 wrap
 * and do their own `openWrap`; a handler for one channel is never called with
 * another channel's wraps.
 */
export function subscribeEphemeral(
  nostr: EphemeralNostr,
  relay: string,
  author: string,
  handler: Handler,
): () => void {
  let line = lines.get(relay);
  if (!line) {
    line = { authors: new Map(), openedAuthors: "" };
    lines.set(relay, line);
  }
  let handlers = line.authors.get(author);
  if (!handlers) {
    handlers = new Set();
    line.authors.set(author, handlers);
  }
  handlers.add(handler);
  schedule(nostr, relay);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = lines.get(relay);
    if (!current) return;
    const set = current.authors.get(author);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) current.authors.delete(author);
    schedule(nostr, relay);
  };
}

function schedule(nostr: EphemeralNostr, relay: string): void {
  const line = lines.get(relay);
  if (!line || line.timer) return;
  line.timer = setTimeout(() => {
    line.timer = undefined;
    reopen(nostr, relay);
  }, REOPEN_MS);
}

function reopen(nostr: EphemeralNostr, relay: string): void {
  const line = lines.get(relay);
  if (!line) return;

  const authors = [...line.authors.keys()].sort();
  const key = authors.join(",");
  if (key === line.openedAuthors && line.controller) return;

  line.controller?.abort();
  line.controller = undefined;
  line.openedAuthors = key;

  if (authors.length === 0) {
    lines.delete(relay);
    return;
  }

  const controller = new AbortController();
  line.controller = controller;
  void (async () => {
    try {
      for await (const msg of nostr.relay(relay).req(
        [{ kinds: [KIND_WRAP_EPHEMERAL], authors }],
        { signal: controller.signal },
      )) {
        if (msg[0] !== "EVENT") continue;
        const event = msg[2] as NostrEvent;
        // Demux strictly by wrap author: a handler sees only its channel's
        // wraps, exactly as its own single-author REQ delivered.
        const handlers = lines.get(relay)?.authors.get(event.pubkey);
        if (!handlers) continue;
        for (const handler of [...handlers]) {
          try {
            handler(event);
          } catch {
            // One consumer's throw must not starve the others.
          }
        }
      }
    } catch {
      // Subscription ended (abort, socket loss). A live socket is re-REQ'd by
      // the relay layer; a torn line is rebuilt by the next (un)subscribe.
    }
  })();
}

/** Test seam: tear down every line. */
export function _resetEphemeralSubsForTests(): void {
  for (const line of lines.values()) {
    line.controller?.abort();
    if (line.timer) clearTimeout(line.timer);
  }
  lines.clear();
}
