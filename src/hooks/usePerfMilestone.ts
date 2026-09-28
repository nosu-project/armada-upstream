import { useEffect, useRef } from "react";

import { perfMark } from "@/lib/perf";

/**
 * One-shot {@link perfMark} the first time `reached` is true, to pin serial load-chain steps
 * on the boot timeline. Once per mount.
 */
export function usePerfMilestone(label: string, reached: boolean, detail?: string): void {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !reached) return;
    marked.current = true;
    perfMark(label, detail);
  }, [label, reached, detail]);
}
