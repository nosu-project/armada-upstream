/**
 * Read-only store census: rows per tenant and per kind, to test whether slow
 * local reads scale with tenant size (e.g. unlimited, never-pruned control
 * editions). Run on the slow machine: `await __armadaDbCensus()`. Counts only.
 */
import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";

/** Kinds worth breaking out, because they're the ones read without a limit. */
const KINDS_OF_INTEREST: { kind: number; what: string }[] = [
  { kind: 3308, what: "Concord control edition" },
  { kind: 3303, what: "Concord rekey round" },
  { kind: 3309, what: "Concord guestbook" },
  { kind: 9, what: "chat message" },
  { kind: 7, what: "reaction" },
  { kind: 1111, what: "comment" },
  { kind: 1059, what: "parked wrap" },
  { kind: 21059, what: "parked wrap (ephemeral)" },
];

export interface TenantCensus {
  tenant: string;
  total: number;
  /** Row counts for {@link KINDS_OF_INTEREST}, omitting empties. */
  byKind: { kind: number; what: string; count: number }[];
}

/**
 * Every tenant to count. `tenantIds()` isn't on the `ArmadaDB` interface, so
 * it's duck-typed; well-known tenants are unioned in.
 */
async function tenantsToCount(db: ReturnType<typeof getArmadaDB>): Promise<string[]> {
  const registry =
    "tenantIds" in db && typeof db.tenantIds === "function"
      ? await (db as { tenantIds(): Promise<string[]> }).tenantIds().catch(() => [])
      : [];
  return [...new Set([...registry, ...Object.values(ARMADA_TENANTS)])];
}

/** Count rows per tenant. */
export async function dbCensus(): Promise<TenantCensus[]> {
  const db = getArmadaDB();
  const ids = await tenantsToCount(db);
  const out: TenantCensus[] = [];
  for (const id of ids) {
    const store = db.tenant(id);
    let total = 0;
    try {
      ({ count: total } = await store.count([{}]));
    } catch {
      // A tenant that won't open still belongs in the report, at zero.
    }
    const byKind: TenantCensus["byKind"] = [];
    for (const { kind, what } of KINDS_OF_INTEREST) {
      try {
        const { count } = await store.count([{ kinds: [kind] }]);
        if (count > 0) byKind.push({ kind, what, count });
      } catch {
        // Skip a kind the engine refused rather than abandoning the tenant.
      }
    }
    out.push({ tenant: id, total, byKind });
  }
  return out.sort((a, b) => b.total - a.total);
}

async function printCensus(): Promise<TenantCensus[]> {
  const census = await dbCensus();
  console.table(
    census.map((t) => ({
      tenant: t.tenant,
      rows: t.total,
      breakdown: t.byKind.map((k) => `${k.count}×${k.kind} (${k.what})`).join(", "),
    })),
  );
  return census;
}

if (typeof window !== "undefined") {
  (window as unknown as { __armadaDbCensus?: () => Promise<TenantCensus[]> }).__armadaDbCensus =
    printCensus;
}
