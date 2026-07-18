/**
 * Dedicated NIP-46 transport — plain WebSockets, no pool machinery.
 *
 * The remote-signer channel used to ride the app's relay pool
 * (NRelay1 + websocket-ts + NPool.group). On Android that stack repeatedly
 * wedged into a state where new REQs never EOSE'd and new EVENTs were never
 * acked on a socket that still delivered old traffic — every remote sign then
 * hung and the send pipeline silently died (see the 2026-07-13 on-device
 * traces). Meanwhile every diagnostic probe that used a PLAIN WebSocket per
 * relay worked flawlessly against the same relays and the same bunker.
 *
 * So the signer gets exactly that: one bare WebSocket per bunker relay with
 * the three behaviors an RPC channel actually needs, and nothing else:
 *
 *  - reconnect on close/error with capped backoff, always
 *  - on (re)open: re-send active REQs and flush queued EVENTs
 *  - on native resume after a long background stint: force-recycle the
 *    sockets (Android leaves them half-open — readyState OPEN, TCP dead)
 *
 * Implements just the `req`/`event` surface NConnectSigner consumes.
 */

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { logSync } from "@/lib/syncLog";

type RelayMsg = ["EVENT", string, NostrEvent] | ["EOSE", string] | ["CLOSED", string, string];

interface ActiveSub {
  filters: NostrFilter[];
  push: (msg: RelayMsg) => void;
  /** Response event ids already delivered (both relays carry every response). */
  seen: Set<string>;
}

interface PendingOk {
  resolve: () => void;
  reject: (err: Error) => void;
  /** Relays that answered OK=false (all false ⇒ reject). */
  denied: Set<string>;
}

/** Reconnect backoff: 1s, 2s, 4s, 8s, then 15s forever. */
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 3), 15_000);

/** Recycle sockets on resume only after this long in the background. */
const RESUME_RECYCLE_MS = 45_000;

class RelayConn {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: string[] = [];
  private stopped = false;

  constructor(
    readonly url: string,
    private onMessage: (url: string, data: string) => void,
    private onOpen: (url: string) => void,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const ws = this.ws;
    ws.onopen = () => {
      this.attempt = 0;
      logSync("nip46", `transport socket open: ${this.url}`);
      // Re-issue active REQs BEFORE flushing queued frames. Kind-24133
      // traffic is ephemeral — a response only reaches subscriptions that are
      // live when it's published — so a queued request EVENT must never jump
      // ahead of the response REQ it depends on. (Queued REQ dups for still-
      // active subs are harmless: a relay just replaces the subscription.)
      this.onOpen(this.url);
      const queued = this.queue;
      this.queue = [];
      for (const frame of queued) ws.send(frame);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.onMessage(this.url, e.data);
    };
    ws.onclose = () => {
      logSync("nip46", `transport socket closed: ${this.url} — reconnecting`);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const wait = backoffMs(this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, wait);
  }

  /** Send now if open, else queue for the next open. */
  send(frame: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(frame);
        return;
      } catch {
        // fall through to queue
      }
    }
    this.queue.push(frame);
  }

  /** Force-close so the reconnect path builds a fresh socket (resume). */
  recycle(): void {
    try {
      this.ws?.close();
    } catch {
      this.scheduleReconnect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }
}

export class Nip46Transport {
  private conns: RelayConn[];
  private subs = new Map<string, ActiveSub>();
  private pendingOks = new Map<string, PendingOk>();
  private backgroundedAt: number | undefined;
  private appStateHandle?: { remove: () => Promise<void> };

  constructor(relays: string[]) {
    this.conns = relays.map(
      (url) => new RelayConn(url, (u, d) => this.route(u, d), (u) => this.resubscribe(u)),
    );
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) {
          this.backgroundedAt = Date.now();
          return;
        }
        const away = this.backgroundedAt === undefined ? 0 : Date.now() - this.backgroundedAt;
        this.backgroundedAt = undefined;
        if (away < RESUME_RECYCLE_MS) return;
        logSync("nip46", `resumed after ${Math.round(away / 1000)}s — recycling transport sockets`);
        for (const c of this.conns) c.recycle();
      }).then((handle) => {
        this.appStateHandle = handle;
      });
    }
  }

  private route(url: string, data: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(data) as unknown[];
    } catch {
      return;
    }
    switch (msg[0]) {
      case "EVENT": {
        const [, subId, event] = msg as ["EVENT", string, NostrEvent];
        const sub = this.subs.get(subId);
        if (!sub || sub.seen.has(event.id)) return;
        sub.seen.add(event.id);
        sub.push(["EVENT", subId, event]);
        return;
      }
      case "EOSE": {
        const [, subId] = msg as ["EOSE", string];
        this.subs.get(subId)?.push(["EOSE", subId]);
        return;
      }
      case "OK": {
        const [, id, ok, reason] = msg as ["OK", string, boolean, string?];
        const pending = this.pendingOks.get(id);
        if (!pending) return;
        if (ok) {
          this.pendingOks.delete(id);
          pending.resolve();
        } else {
          pending.denied.add(url);
          if (pending.denied.size >= this.conns.length) {
            this.pendingOks.delete(id);
            pending.reject(new Error(reason || "rejected by every relay"));
          }
        }
        return;
      }
      // CLOSED/AUTH/NOTICE: deliberately ignored. Kind-24133 traffic is not
      // auth-gated on the bunker relays, and a relay-initiated CLOSED is
      // handled by the reconnect+resubscribe path, never surfaced to
      // NConnectSigner (which treats CLOSED as fatal).
    }
  }

  /** Re-issue every active REQ on a (re)opened socket. */
  private resubscribe(url: string): void {
    const conn = this.conns.find((c) => c.url === url);
    if (!conn) return;
    for (const [subId, sub] of this.subs) {
      conn.send(JSON.stringify(["REQ", subId, ...sub.filters]));
    }
  }

  /** Publish to every relay; resolves on the first OK=true. */
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        this.pendingOks.delete(event.id);
        reject(new Error("publish aborted"));
      };
      this.pendingOks.set(event.id, {
        resolve: () => done(resolve),
        reject: (e) => done(() => reject(e)),
        denied: new Set(),
      });
      if (opts?.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const frame = JSON.stringify(["EVENT", event]);
      for (const c of this.conns) c.send(frame);
    });
  }

  /** Live subscription across all relays (deduped); ends only on abort. */
  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<RelayMsg> {
    const subId = crypto.randomUUID();
    const subs = this.subs;
    const conns = this.conns;

    const queue: RelayMsg[] = [];
    let wake: (() => void) | undefined;
    let ended = false;

    const sub: ActiveSub = {
      filters,
      seen: new Set(),
      push: (msg) => {
        queue.push(msg);
        wake?.();
      },
    };
    subs.set(subId, sub);
    const frame = JSON.stringify(["REQ", subId, ...filters]);
    for (const c of conns) c.send(frame);

    const end = () => {
      if (ended) return;
      ended = true;
      subs.delete(subId);
      const close = JSON.stringify(["CLOSE", subId]);
      for (const c of conns) c.send(close);
      wake?.();
    };
    opts?.signal?.addEventListener("abort", end, { once: true });
    if (opts?.signal?.aborted) end();

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            if (ended) return;
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
        } finally {
          end();
        }
      },
    };
  }

  /**
   * Tear the transport down: stop every socket (no reconnects) and drop the
   * app-state listener. Used by the nostrconnect:// pairing handshake, which
   * runs on a throwaway transport before the session transport exists. Any
   * pending publish/req settles via its own abort path.
   */
  close(): void {
    for (const c of this.conns) c.stop();
    void this.appStateHandle?.remove();
    this.appStateHandle = undefined;
  }
}

/** One transport per bunker identity, shared by every signer that needs it. */
const transports = new Map<string, Nip46Transport>();

/**
 * Get (or create) the app-wide NIP-46 transport for a bunker login. Keyed by
 * the bunker pubkey + relay set so a re-pairing with different relays gets a
 * fresh transport.
 */
export function getNip46Transport(bunkerPubkey: string, relays: string[]): Nip46Transport {
  const key = `${bunkerPubkey}|${[...relays].sort().join(",")}`;
  let t = transports.get(key);
  if (!t) {
    logSync("nip46", `creating dedicated transport for bunker ${bunkerPubkey.slice(0, 8)} (${relays.length} relay(s))`);
    t = new Nip46Transport(relays);
    transports.set(key, t);
  }
  return t;
}

/**
 * Close and forget the transport for a bunker identity. Used when a pairing
 * attempt fails — without it the rejected attempt's sockets would keep
 * reconnecting for the rest of the page's lifetime.
 */
export function removeNip46Transport(bunkerPubkey: string, relays: string[]): void {
  const key = `${bunkerPubkey}|${[...relays].sort().join(",")}`;
  const t = transports.get(key);
  if (t) {
    transports.delete(key);
    t.close();
  }
}
