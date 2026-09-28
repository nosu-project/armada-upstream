/**
 * {@link ArmadaSqlDriver} over `node:sqlite`, used by the Electron main process
 * and the conformance suite (so desktop ships the tested engine). `DatabaseSync`
 * is synchronous, satisfying the in-order single-connection contract. The
 * statement cache is capped and dropped wholesale (`IN (…)` lengths vary).
 */
import { DatabaseSync } from "node:sqlite";

import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

type Prepared = ReturnType<DatabaseSync["prepare"]>;

const MAX_CACHED_STATEMENTS = 512;

export interface NodeSqlDriverOpts {
  /** WAL mode (reads during writes). Default `true`; skipped for in-memory DBs. */
  wal?: boolean;
}

export class NodeSqlDriver implements ArmadaSqlDriver {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Prepared>();

  constructor(path = ":memory:", opts: NodeSqlDriverOpts = {}) {
    this.db = new DatabaseSync(path);

    if (opts.wal !== false && path !== ":memory:" && !path.startsWith("file::memory:")) {
      // Advisory: a filesystem refusing WAL (network share) keeps the rollback journal.
      try {
        this.db.exec(`PRAGMA journal_mode = WAL`);
        this.db.exec(`PRAGMA synchronous = NORMAL`);
      } catch {
        // keep the default journal
      }
    }

    // Avoid immediate SQLITE_BUSY if a future build opens a second connection.
    try {
      this.db.exec(`PRAGMA busy_timeout = 5000`);
    } catch {
      // older builds without the pragma just fail fast, as before
    }
  }

  private prepare(sql: string): Prepared {
    let statement = this.statements.get(sql);
    if (!statement) {
      // Wholesale drop: entries are interchangeable and an LRU isn't worth it.
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
    // Closing finalizes the cached statements.
    this.statements.clear();
    this.db.close();
  }
}
