/**
 * The ArmadaDB server that runs in the Electron desktop shell's MAIN process.
 *
 * Desktop is the third storage arrangement, and it is deliberately shaped like
 * Android's rather than like the web's: the query engine runs outside the
 * renderer, against one SQLite file on disk in the OS's per-app config
 * directory, and the renderer reaches it over a bridge. What the web build gets
 * instead is Chromium's IndexedDB, partitioned by the renderer's origin and
 * living inside the browser profile — fine for a tab, but on a desktop app it
 * means the user's messages are somewhere they can neither find nor back up,
 * and it means the engine is the one the conformance suite does NOT run.
 *
 * The engine here is {@link SqliteArmadaDB} — the same TypeScript store the
 * suite exercises, on the same schema the Kotlin port implements. Nothing about
 * it is desktop-specific; this module only owns the file, the driver, and the
 * dispatch table.
 *
 * The dispatch surface is `ArmadaDbPlugin`'s, method for method, including its
 * JSON-text payloads. That is not incidental: the renderer adapter is
 * `NativeArmadaDB`, unchanged, with this bridge substituted for the Capacitor
 * one — so the write batching, the KV op coalescing and the read-your-writes
 * ordering that Android needed are already written, already tested, and cannot
 * drift between the two platforms that use them.
 *
 * This module must stay free of Electron imports: `main.js` owns the IPC
 * channel and hands the file path in. Keeping it Electron-free is also what
 * lets `tsc` and the linter cover it as ordinary `src/` code.
 */
import { SqliteArmadaDB } from "./SqliteArmadaDB";
import { NodeSqlDriver } from "./nodeSqlDriver";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaKVEntry, ArmadaKVListOptions, ArmadaKVSelector } from "./types";

/** One entry as it crosses the bridge: the value is stored JSON TEXT. */
interface WireKvEntry {
  key: string;
  value: string;
}

/** A queued KV operation, as `kvOps` receives it. */
type WireKvOp =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string }
  | ({ op: "list" } & ArmadaKVSelector & ArmadaKVListOptions);

/** What one `kvOps` entry answers with, aligned by position with the request. */
type WireKvResult = string | null | WireKvEntry[];

export interface ArmadaDbServer {
  /**
   * Run one `ArmadaDbPlugin` method. `op` is the method name and `payload` its
   * options object; the result is the method's return value.
   *
   * @throws if `op` is not a method of the surface, or the operation fails.
   */
  call(op: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Release the SQLite connection. */
  close(): Promise<void>;
}

/**
 * Open (or create) the ArmadaDB file at `file` and return its dispatch table.
 *
 * The schema is installed on construction, and every operation awaits that —
 * so the first call after launch is the one that waits, not the caller who
 * happened to race it.
 */
export function openArmadaDbServer(file: string): ArmadaDbServer {
  const driver = new NodeSqlDriver(file);
  const db = new SqliteArmadaDB(driver);

  /**
   * Every tenant the file has ever held, read from the interning table the
   * store keeps for its tag index. Read through the driver because the tenant
   * registry is an implementation detail of the SQLite layout rather than part
   * of the `ArmadaDB` interface — the IndexedDB adapter's registry is a KV
   * table, and neither is the other's business.
   */
  async function tenantIds(): Promise<string[]> {
    await db.ready;
    const rows = await driver.all(`SELECT id FROM tenants ORDER BY id`);
    return rows.map((row) => String(row.id));
  }

  /**
   * Serialize a KV value back to the JSON text the bridge carries.
   *
   * The store parsed it on the way in, so this is a re-serialization rather
   * than a passthrough — lossless in practice because the value was produced by
   * `JSON.stringify` in the renderer to begin with, so there is no number
   * spelling here that JavaScript did not already choose. `undefined` has no
   * JSON form and cannot have been stored; it is reported as a miss.
   */
  function toWire(value: unknown): string | null {
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  }

  async function kvList(selector: ArmadaKVSelector, opts: ArmadaKVListOptions): Promise<WireKvEntry[]> {
    const entries = await db.kv.list<unknown>(selector, opts);
    return entries.map(({ key, value }: ArmadaKVEntry<unknown>) => ({
      key,
      value: toWire(value) ?? "null",
    }));
  }

  /**
   * Run a burst of KV operations in arrival order.
   *
   * Sequential rather than concurrent, which is the part that matters: the
   * renderer coalesces a whole microtask's worth of gets, sets and lists into
   * one crossing, and read-your-writes within that burst is only true if they
   * execute in the order they were queued. Unlike the Kotlin port this is not
   * one transaction — each write is its own commit — so a crash mid-burst can
   * leave a prefix of it applied. Every KV key Armada stores is independently
   * meaningful (a cursor, a fold, a setting), so a prefix is a stale entry to
   * be rewritten, not a corrupt pair of entries.
   */
  async function kvOps(ops: WireKvOp[]): Promise<WireKvResult[]> {
    const results: WireKvResult[] = [];
    for (const op of ops) {
      if (op.op === "get") {
        const value = await db.kv.get<unknown>(op.key);
        results.push(value === undefined ? null : toWire(value));
      } else if (op.op === "set") {
        await db.kv.set(op.key, JSON.parse(op.value) as unknown);
        results.push(null);
      } else if (op.op === "delete") {
        await db.kv.delete(op.key);
        results.push(null);
      } else {
        const { op: _op, limit, reverse, ...selector } = op;
        results.push(await kvList(selector, { limit, reverse }));
      }
    }
    return results;
  }

  const handlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    async query({ tenant, filters }) {
      const rumors = await db.tenant(String(tenant)).query(
        JSON.parse(String(filters)) as NostrFilter[],
      );
      return { rumors: JSON.stringify(rumors) };
    },

    async event({ tenant, rumors }) {
      const store = db.tenant(String(tenant));
      const batch = JSON.parse(String(rumors)) as NostrRumor[];
      // Issued without awaiting between them so the whole batch lands in the
      // store's own microtask window, i.e. one transaction — the same reason
      // the renderer bothered to coalesce them into one crossing.
      await Promise.all(batch.map((rumor) => store.event(rumor)));
    },

    async count({ tenant, filters }) {
      return await db.tenant(String(tenant)).count(JSON.parse(String(filters)) as NostrFilter[]);
    },

    async remove({ tenant, filters }) {
      await db.tenant(String(tenant)).remove(JSON.parse(String(filters)) as NostrFilter[]);
    },

    async tenants() {
      return { tenants: JSON.stringify(await tenantIds()) };
    },

    async kvGet({ key }) {
      const value = await db.kv.get<unknown>(String(key));
      // The key is ABSENT rather than null when unset: null is a value a caller
      // can legitimately have stored, and the two must stay distinguishable.
      if (value === undefined) return {};
      const text = toWire(value);
      return text === null ? {} : { value: text };
    },

    async kvSet({ key, value }) {
      await db.kv.set(String(key), JSON.parse(String(value)) as unknown);
    },

    async kvDelete({ key }) {
      await db.kv.delete(String(key));
    },

    async kvList({ prefix, start, end, limit, reverse }) {
      const selector: ArmadaKVSelector = {};
      if (typeof prefix === "string") selector.prefix = prefix;
      if (typeof start === "string") selector.start = start;
      if (typeof end === "string") selector.end = end;

      const opts: ArmadaKVListOptions = {};
      if (typeof limit === "number") opts.limit = limit;
      if (typeof reverse === "boolean") opts.reverse = reverse;

      return { entries: JSON.stringify(await kvList(selector, opts)) };
    },

    async kvOps({ ops }) {
      return { results: JSON.stringify(await kvOps(JSON.parse(String(ops)) as WireKvOp[])) };
    },

    async wipe() {
      await db.wipe();
    },
  };

  return {
    async call(op: string, payload: Record<string, unknown> = {}) {
      const handler = handlers[op];
      if (!handler) throw new Error(`Unknown ArmadaDB operation: ${op}`);
      const result = await handler(payload);
      // `undefined` is not a structured-clone value the IPC layer can carry
      // back for the void methods.
      return result ?? null;
    },

    async close() {
      await db.close();
    },
  };
}
