/**
 * Named size probes for a profiling build's memory census
 * (`__armadaPerf.memory()`, `scripts/perf-profile.mjs`'s leak scenarios). A
 * no-op in every other build, so a normal bundle holds no reference to what
 * it measures.
 */

const probes = new Map<string, () => number>();

/** Report `size()` under `name` in the census; a later registration under the same name wins. */
export function registerMemoryProbe(name: string, size: () => number): void {
  if (import.meta.env.VITE_PROFILE !== "1") return;
  probes.set(name, size);
}

/** Every probe's current size; one that throws reports -1 rather than ending the census. */
export function readMemoryProbes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, size] of probes) {
    try {
      out[name] = size();
    } catch {
      out[name] = -1;
    }
  }
  return out;
}
