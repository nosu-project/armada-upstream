/**
 * SQLite-WASM worker for web/Electron: opens the shared-schema event database
 * on OPFS via the `opfs-sahpool` VFS (synchronous access handles — no
 * COOP/COEP headers needed, at the cost of being single-connection, which is
 * fine for a single-page app). Falls back to an in-memory database when OPFS
 * is unavailable; the driver on the main thread then prefers the persistent
 * IndexedDB store instead (see eventStore.ts).
 *
 * The wasm binary ships as a bundled asset (`?url` import), so it loads from
 * our own origin — bundled/offline on Electron and Capacitor, ordinary
 * static-asset caching on the web.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";

import { EVENT_DB_SCHEMA } from "./schema";

import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { SqlParam } from "./driver";

/**
 * The published type for the init function takes no arguments, but the
 * runtime accepts an Emscripten module config — `locateFile` is how the wasm
 * binary is resolved to our bundled asset URL.
 */
const initModule = sqlite3InitModule as unknown as (opts?: {
  locateFile?: (file: string) => string;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;
}) => Promise<Sqlite3Static>;

/** OPFS directory the SAH pool claims (removed wholesale on purge). */
const SAH_DIRECTORY = ".armada-sqlite";
/** Database filename within the pool. */
const DB_FILENAME = "/armada-events.db";

interface RunRequest {
  id: number;
  op: "run";
  statements: Array<{ sql: string; params?: SqlParam[] }>;
}
interface QueryRequest {
  id: number;
  op: "query";
  sql: string;
  params?: SqlParam[];
}
interface CloseRequest {
  id: number;
  op: "close";
}
type Request = RunRequest | QueryRequest | CloseRequest;

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: Request }) => void) | null;
  close(): void;
};

const ready: Promise<Database> = (async () => {
  const sqlite3 = await initModule({
    // Resolve the wasm binary to the bundled asset URL instead of a path
    // relative to the (bundled, renamed) module.
    locateFile: () => wasmUrl,
    print: () => {},
    printErr: () => {},
  });

  let db: Database;
  let vfs: "opfs-sahpool" | "memory";
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: SAH_DIRECTORY });
    db = new pool.OpfsSAHPoolDb(DB_FILENAME);
    vfs = "opfs-sahpool";
  } catch {
    // No OPFS (insecure context, old browser, file://) — session-only cache.
    db = new sqlite3.oo1.DB(":memory:");
    vfs = "memory";
  }

  for (const stmt of EVENT_DB_SCHEMA) db.exec(stmt);
  scope.postMessage({ type: "ready", vfs });
  return db;
})();

// Surface an init failure to the driver (which then falls back to IndexedDB).
ready.catch((err) => {
  scope.postMessage({ type: "init-error", error: String(err) });
});

scope.onmessage = async (e) => {
  const msg = e.data;
  let db: Database;
  try {
    db = await ready;
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: String(err) });
    return;
  }

  try {
    if (msg.op === "run") {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of msg.statements) {
          db.exec({ sql: s.sql, bind: s.params?.length ? s.params : undefined });
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw err;
      }
      scope.postMessage({ id: msg.id, ok: true });
    } else if (msg.op === "query") {
      const rows = db.selectArrays(msg.sql, msg.params?.length ? msg.params : undefined);
      scope.postMessage({ id: msg.id, ok: true, rows });
    } else {
      db.close();
      scope.postMessage({ id: msg.id, ok: true });
      scope.close();
    }
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: String(err) });
  }
};
