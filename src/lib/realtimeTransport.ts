/**
 * Lazy access to the iroh gossip transport (`crates/webxdc-rt`).
 *
 * Two constraints shape this. The wasm is ~2.8 MB, which nobody who never
 * opens a Mini App should pay for, so it is imported on first use and never
 * from module scope. And it is built by a Rust toolchain that CI does not
 * have, so its absence has to be an ordinary answer rather than a build
 * failure: callers get `undefined` and fall back to the Nostr plane.
 */

/** The slice of the wasm class this app uses. */
export interface RealtimeTransport {
  publicKeyHex(): string;
  nodeAddrJson(): string;
  join(
    topic: Uint8Array,
    peerAddrsJson: string[],
    onMessage: (bytes: Uint8Array) => void,
    onEvent?: (msg: string) => void,
  ): Promise<void>;
  send(topic: Uint8Array, frame: Uint8Array): Promise<void>;
  addPeer(topic: Uint8Array, peerAddrJson: string): Promise<void>;
  leave(topic: Uint8Array): void;
}

interface WasmModule {
  default: (input?: unknown) => Promise<unknown>;
  RealtimeNode: new () => Promise<RealtimeTransport>;
}

/** Where `npm run build:wasm` puts the package. */
const MODULE_PATH = "/src/wasm/webxdc-rt/webxdc_rt.js";

let pending: Promise<RealtimeTransport | undefined> | undefined;

/**
 * The process-wide node, created once.
 *
 * Binding costs a relay handshake of a few seconds, so a second Mini App must
 * reuse the first one's node rather than pay it again — and two endpoints on
 * one relay would advertise two addresses for one person, which reads to
 * everyone else as two players.
 */
export function realtimeTransport(): Promise<RealtimeTransport | undefined> {
  pending ??= load();
  return pending;
}

async function load(): Promise<RealtimeTransport | undefined> {
  try {
    const mod = (await import(/* @vite-ignore */ MODULE_PATH)) as WasmModule;
    await mod.default();
    return await new mod.RealtimeNode();
  } catch (e) {
    // Not built, or the browser refused it. Realtime degrades to the Nostr
    // plane; everything else about the Mini App is unaffected.
    console.warn("[webxdc] realtime transport unavailable, using the relay path", e);
    return undefined;
  }
}

/** Test seam: forget the cached node so the next call rebuilds it. */
export function resetRealtimeTransport(): void {
  pending = undefined;
}
