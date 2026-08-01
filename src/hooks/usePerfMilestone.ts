import { useEffect, useRef } from "react";

import { perfMark } from "@/lib/perf";

/**
 * Record a one-shot {@link perfMark} the first time `reached` becomes true.
 *
 * For pinning the steps of a serial load chain onto the boot timeline —
 * "community resolved", "control folded", "channels resolved", "timeline
 * painted" — so a profile says WHICH link the user waited on instead of only
 * that the whole chain was slow. Fires once per mount: a value that flickers
 * back to false and returns is not a second milestone, it's the same one.
 */
export function usePerfMilestone(label: string, reached: boolean, detail?: string): void {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !reached) return;
    marked.current = true;
    perfMark(label, detail);
  }, [label, reached, detail]);
}
