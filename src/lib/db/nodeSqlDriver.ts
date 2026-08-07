/**
 * {@link ArmadaSqlDriver} over Node's built-in SQLite (`node:sqlite`).
 *
 * This is the driver the Electron desktop shell's main process runs
 * {@link SqliteArmadaDB} on, and the same one the conformance suite uses
 * against `:memory:` — so the engine the desktop build ships is the engine the
 * tests exercise, not a lookalike.
 *
 * `DatabaseSync` is synchronous, which satisfies the driver contract's real
 * requirement exactly: statements run in call order on ONE connection, with no
 * multiplexing and no reordering. The store's `BEGIN IMMEDIATE` / `COMMIT` are
 * ordinary statements to it, so a transaction is whatever ran between them.
 *
 * Statements are cached by SQL text, as the contract invites. The store reuses
 * statement shapes deliberately, but a shape still varies with the length of an
 * `IN (…)` list, so the cache is capped and dropped wholesale rather than
 * growing one entry per list length ever seen.
 */
import { DatabaseSync } from "node:sqlite";

import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/** A prepared statement, as `node:sqlite` hands it back. */
type Prepared = ReturnType<DatabaseSync["prepare"]>;

/** Most prepared statements kept before the cache is dropped and rebuilt. */
const MAX_CACHED_STATEMENTS = 512;

export interface NodeSqlDriverOpts {
  /**
   * Whether to put the file in WAL mode. Default `true`, and skipped
   * automatically for in-memory databases, which have no journal to switch.
   *
   * WAL is what lets a read run while a write is in flight. It costs two
   * sidecar files (`-wal`, `-shm`) next to the database.
   */
  wal?: boolean;
}

export class NodeSqlDriver implements ArmadaSqlDriver {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Prepared>();

  constructor(path = ":memory:", opts: NodeSqlDriverOpts = {}) {
    this.db = new DatabaseSync(path);

    if (opts.wal !== false && path !== ":memory:" && !path.startsWith("file::memory:")) {
      // `journal_mode` returns a row, which `exec` discards — the mode is only
      // advisory here, and a filesystem that refuses WAL (a network share) keeps
      // the rollback journal and still works.
      try {
        this.db.exec(`PRAGMA journal_mode = WAL`);
        this.db.exec(`PRAGMA synchronous = NORMAL`);
      } catch {
        // keep the default journal
      }
    }

    // A second connection can only appear if a future build opens one (a
    // maintenance task, a second window's own process), and this is what keeps
    // that from turning into an immediate SQLITE_BUSY.
    try {
      this.db.exec(`PRAGMA busy_timeout = 5000`);
    } catch {
      // older builds without the pragma just fail fast, as before
    }
  }

  private prepare(sql: string): Prepared {
    let statement = this.statements.get(sql);
    if (!statement) {
      // Dropped wholesale rather than evicted one at a time: the entries are
      // interchangeable (a statement is re-prepared on demand) and an LRU would
      // cost more bookkeeping than the misses it avoids.
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear();
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    return this.prepare(sql).all(...params) as SqlRow[];
  }

  close(): void {
    // The cached statements belong to the connection; closing it finalizes
    // them, and holding the handles afterwards would only invite a use of one.
    this.statements.clear();
    this.db.close();
  }
}
