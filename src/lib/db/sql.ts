import type { SqlValue } from "./driver";

/** `?, ?, ?` — a placeholder list of the given length. */
export function qs(length: number): string {
  return new Array(length).fill("?").join(", ");
}

/**
 * `= ?` for one value, `IN (…)` for several: equality keeps the index scan
 * ordered for `ORDER BY created_at DESC`; `IN (?)` measurably slows tag scans.
 */
export function memberOf(column: string, values: readonly SqlValue[]): string {
  return values.length === 1 ? `${column} = ?` : `${column} IN (${qs(values.length)})`;
}

/** Join conditions into a `WHERE` clause, or nothing if there are none. */
export function where(conditions: string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

/** Split values into chunks that fit within a statement's parameter budget. */
export function* batch<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) {
    yield values.slice(i, i + size);
  }
}
