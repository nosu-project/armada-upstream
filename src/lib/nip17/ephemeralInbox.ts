/**
 * One standing `{kinds:[21059], "#p":[me]}` REQ per relay, shared by every
 * consumer of the DM plane's ephemeral wraps (today: typing indicators).
 *
 * The filter names the RECIPIENT, never a conversation, so a per-conversation
 * subscription was the same REQ closed and reopened on every conversation
 * switch — a measured 120 REQs across 60 switches, each a radio wake on a
 * phone. Here a line is keyed by (relay, recipient), consumers register a
 * handler, and the REQ outlives its last consumer by {@link LINGER_MS} so a
 * switch (unmount old, mount new) never reaches the socket at all.
 *
 * The same wrap arrives once per relay that carries it; it is fanned out once,
 * so a consumer decrypts it once rather than once per relay.
 *
 * Ephemeral wraps are never stored, so there is nothing to replay across a
 * reopen: a signal lost in a gap is a heartbeat the sender resends. A dropped
 * socket is re-REQ'd by the relay layer, as for `concord/lib/ephemeralSub.ts`.
 */
import { KIND_DM_WRAP_EPHEMERAL } from "@/lib/nip17/protocol";

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

type Handler = (wrap: NostrEvent) => void;

interface Line {
  handlers: Set<Handler>;
  controller: AbortController;
  /** Pending close once the last handler left. */
  linger?: ReturnType<typeof setTimeout>;
}

/** How long a line with no consumers stays open, to absorb a conversation switch. */
export const LINGER_MS = 30_000;
/** Wrap ids already fanned out, per recipient, to drop the other relays' copies. */
const SEEN_CAP = 256;

const lines = new Map<string, Line>();
const seen = new Map<string, Set<string>>();

function firstSighting(recipient: string, id: string): boolean {
  let ids = seen.get(recipient);
  if (!ids) {
    ids = new Set();
    seen.set(recipient, ids);
  }
  if (ids.has(id)) return false;
  ids.add(id);
  if (ids.size > SEEN_CAP) ids.delete(ids.values().next().value as string);
  return true;
}

function open(nostr: EphemeralNostr, relay: string, recipient: string, key: string): Line {
  const line: Line = { handlers: new Set(), controller: new AbortController() };
  const { signal } = line.controller;
  void (async () => {
    try {
      for await (const msg of nostr.relay(relay).req(
        [{ kinds: [KIND_DM_WRAP_EPHEMERAL], "#p": [recipient], since: Math.floor(Date.now() / 1000) }],
        { signal },
      )) {
        if (msg[0] !== "EVENT") continue;
        const wrap = msg[2] as NostrEvent;
        if (!firstSighting(recipient, wrap.id)) continue;
        for (const handler of [...line.handlers]) {
          try {
            handler(wrap);
          } catch {
            // One consumer's throw must not starve the others.
          }
        }
      }
    } catch (err) {
      // Teardown aborts the sub; only a real failure is worth reporting. A
      // relay that rejects kind 21059 (or the filter) surfaces here, and
      // silence made that indistinguishable from "nobody is typing".
      if (!signal.aborted) console.warn(`[dm-ephemeral] subscription to ${relay} ended:`, err);
    } finally {
      // A line whose REQ ended on its own is rebuilt by the next subscribe.
      if (lines.get(key) === line) lines.delete(key);
    }
  })();
  return line;
}

/**
 * Receive the ephemeral DM wraps addressed to `recipient` on `relay`. Returns
 * an unsubscribe. Handlers get the raw wrap and do their own unwrapping.
 */
export function subscribeDmEphemeral(
  nostr: EphemeralNostr,
  relay: string,
  recipient: string,
  handler: Handler,
): () => void {
  const key = `${relay}\u0000${recipient}`;
  let line = lines.get(key);
  if (!line) {
    line = open(nostr, relay, recipient, key);
    lines.set(key, line);
  }
  if (line.linger) {
    clearTimeout(line.linger);
    line.linger = undefined;
  }
  line.handlers.add(handler);

  const held = line;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.handlers.delete(handler);
    if (held.handlers.size > 0 || lines.get(key) !== held) return;
    held.linger = setTimeout(() => {
      if (held.handlers.size > 0) return;
      held.controller.abort();
      if (lines.get(key) === held) lines.delete(key);
    }, LINGER_MS);
  };
}

/** Close every line now — logout must not keep the old account's REQs open. */
export function closeDmEphemeralSubs(): void {
  for (const line of lines.values()) {
    if (line.linger) clearTimeout(line.linger);
    line.controller.abort();
  }
  lines.clear();
  seen.clear();
}
