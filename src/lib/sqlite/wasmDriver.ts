import type { SqlDriver, SqlParam } from "./driver";

/** How long the worker gets to initialize before we give up on it. */
const INIT_TIMEOUT_MS = 20_000;

export interface WasmSqlDriver extends SqlDriver {
  /**
   * The VFS the worker actually got. `memory` means OPFS was unavailable —
   * the caller should prefer the persistent IndexedDB fallback instead.
   */
  vfs: "opfs-sahpool" | "memory";
}

interface WorkerResponse {
  type?: "ready" | "init-error";
  vfs?: "opfs-sahpool" | "memory";
  id?: number;
  ok?: boolean;
  rows?: SqlParam[][];
  error?: string;
}

/**
 * Spin up the SQLite-WASM worker and wrap its message protocol as a
 * {@link SqlDriver}. Rejects when Workers are unavailable (jsdom tests), the
 * worker fails to boot, or init times out — the caller then falls back to
 * the IndexedDB store (see eventStore.ts).
 */
export function openWasmDriver(): Promise<WasmSqlDriver> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./wasm.worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }

    const pending = new Map<number, { resolve: (rows: SqlParam[][]) => void; reject: (err: Error) => void }>();
    let nextId = 1;
    let settled = false;

    const initTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error("sqlite-wasm worker init timed out"));
    }, INIT_TIMEOUT_MS);

    const request = (message: Record<string, unknown>): Promise<SqlParam[][]> => {
      const id = nextId++;
      return new Promise<SqlParam[][]>((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ id, ...message });
      });
    };

    const driver: WasmSqlDriver = {
      vfs: "opfs-sahpool",
      async run(statements) {
        await request({ op: "run", statements });
      },
      async query(sql, params) {
        return await request({ op: "query", sql, params });
      },
      async close() {
        try {
          await request({ op: "close" });
        } finally {
          worker.terminate();
        }
      },
    };

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        driver.vfs = msg.vfs ?? "memory";
        resolve(driver);
        return;
      }
      if (msg.type === "init-error") {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        worker.terminate();
        reject(new Error(msg.error ?? "sqlite-wasm init failed"));
        return;
      }
      if (typeof msg.id !== "number") return;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.rows ?? []);
      else waiter.reject(new Error(msg.error ?? "sqlite-wasm request failed"));
    };

    worker.onerror = (e) => {
      const error = new Error(e.message || "sqlite-wasm worker error");
      if (!settled) {
        settled = true;
        clearTimeout(initTimer);
        worker.terminate();
        reject(error);
      }
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(error);
      }
    };
  });
}
