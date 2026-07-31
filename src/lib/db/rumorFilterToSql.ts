import type { NostrFilter } from "@nostrify/nostrify";
import type { SqlParam } from "@/lib/sqlite/driver";

/** A compiled single-filter query (SELECT e.raw … or SELECT COUNT…). */
export interface FilterQuery {
  sql: string;
  params: SqlParam[];
}

/** Escape LIKE wildcards so a `search` term matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Compile one NIP-01 filter, scoped to a tenant, against the rumor schema
 * (sqliteSchema.ts). Returns `null` when the filter can never match (an empty
 * array constraint, per NIP-01).
 *
 * Semantics mirror `NIndexedDB`, so the two ArmadaDB adapters agree:
 *  - `ids` / `authors` / `kinds`: set membership.
 *  - `#x` tag filters AND together; within one, values OR. Only tags the
 *    write path indexed can match — a filter on anything else matches
 *    nothing, naturally, because `rumor_tags` has no such rows.
 *  - `since` / `until`: inclusive bounds.
 *  - `search`: substring match on content (SQLite LIKE — ASCII
 *    case-insensitive, close enough to NIndexedDB's lowercased includes()).
 *  - Results newest-first, ties broken by smaller id first; `limit` applied
 *    per filter.
 *
 * This is a tenant-scoped sibling of `src/lib/sqlite/filterToSql.ts`, which
 * compiles against the signed-event schema; that one goes away once ArmadaDB
 * subsumes the event store.
 */
export function rumorFilterToSql(
  tenant: string,
  filter: NostrFilter,
  opts?: { count?: boolean },
): FilterQuery | null {
  // The tenant predicate leads every query and every index.
  const where: string[] = ["e.tenant = ?"];
  const joins: string[] = [];
  const params: SqlParam[] = [tenant];
  let joinN = 0;

  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value) && value.length === 0) return null; // never matches

    if (key === "ids") {
      const ids = value as string[];
      where.push(`e.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    } else if (key === "authors") {
      const authors = value as string[];
      where.push(`e.pubkey IN (${authors.map(() => "?").join(",")})`);
      params.push(...authors);
    } else if (key === "kinds") {
      const kinds = value as number[];
      where.push(`e.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    } else if (key === "since") {
      where.push(`e.created_at >= ?`);
      params.push(value as number);
    } else if (key === "until") {
      where.push(`e.created_at <= ?`);
      params.push(value as number);
    } else if (key === "search") {
      where.push(`e.content LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(value as string)}%`);
    } else if (key.startsWith("#") && key.length >= 2) {
      // One join per tag filter (filters AND); IN over the values (values OR).
      // The join carries the tenant across so it stays on the covering index.
      const name = key.slice(1);
      const values = value as string[];
      const t = `t${joinN++}`;
      joins.push(`JOIN rumor_tags ${t} ON ${t}.tenant = e.tenant AND ${t}.event_id = e.id`);
      where.push(`${t}.name = ? AND ${t}.value IN (${values.map(() => "?").join(",")})`);
      params.push(name, ...values);
    }
    // `limit` handled below; unknown keys are ignored (lenient cache).
  }

  const whereSql = ` WHERE ${where.join(" AND ")}`;
  const joinSql = joins.length > 0 ? ` ${joins.join(" ")}` : "";

  if (opts?.count) {
    return {
      sql: `SELECT COUNT(DISTINCT e.seq) FROM rumors e${joinSql}${whereSql}`,
      params,
    };
  }

  // Joins can fan out (an event matching several values of one tag); GROUP BY
  // collapses it back to one row per event.
  const groupSql = joins.length > 0 ? " GROUP BY e.seq" : "";
  let sql =
    `SELECT e.raw FROM rumors e${joinSql}${whereSql}${groupSql}` +
    ` ORDER BY e.created_at DESC, e.id ASC`;

  if (typeof filter.limit === "number") {
    if (filter.limit <= 0) return null;
    sql += ` LIMIT ?`;
    params.push(Math.floor(filter.limit));
  }

  return { sql, params };
}
