/**
 * Lazy access to the iroh gossip transport (`crates/webxdc-rt`): ~2.8 MB wasm,
 * imported on first use and optional (CI can't build it). Without it Mini Apps
 * still sync durable state but have no realtime — a Nostr substitute would split
 * games between Armada and Vector players.
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

/**
 * `import.meta.glob` so the package may be absent: Vite emits a lazy chunk when
 * built and an empty map otherwise. A plain `import(path)` either fails the
 * build or (with `@vite-ignore`) 404s from `dist`.
 */
const CANDIDATES = import.meta.glob("/src/wasm/webxdc-rt/webxdc_rt.js");

let pending: Promise<RealtimeTransport | undefined> | undefined;

/**
 * The process-wide node, created once: binding takes seconds, and two endpoints
 * would look like two players to everyone else.
 */
export function realtimeTransport(): Promise<RealtimeTransport | undefined> {
  pending ??= load();
  return pending;
}

async function load(): Promise<RealtimeTransport | undefined> {
  const loader = CANDIDATES[MODULE_PATH];
  if (!loader) {
    console.info("[webxdc] realtime transport not built — Mini App multiplayer is off (npm run build:wasm)");
    return undefined;
  }
  try {
    const mod = (await loader()) as WasmModule;
    await mod.default();
    return await new mod.RealtimeNode();
  } catch (e) {
    // Built but unusable (old browser, blocked relay): multiplayer is off, durable sync still works.
    console.warn("[webxdc] realtime transport unavailable — Mini App multiplayer is off", e);
    return undefined;
  }
}
