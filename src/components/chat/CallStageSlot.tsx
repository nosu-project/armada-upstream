import { useContext, useEffect, useRef } from "react";

import { PaneCoveredContext } from "@/contexts/PaneCoveredContext";
import { useCall } from "@/hooks/useCall";

/**
 * Top-of-chat slot CallProvider reparents the persistent stage host into when
 * `active`. Separate module so pages rendering it don't pull in LiveKit.
 * Steps aside while its pane is swiped off screen: the docked stage carries the
 * call controls, so the floating window and call bar must take over there.
 */
export function CallStageSlot({ active }: { active: boolean }) {
  const { registerCallStageSlot } = useCall();
  const covered = useContext(PaneCoveredContext);
  const ref = useRef<HTMLDivElement | null>(null);
  const live = active && !covered;

  useEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (!el) return;
    return registerCallStageSlot(el);
  }, [live, registerCallStageSlot]);

  if (!live) return null;
  return <div ref={ref} className="shrink-0" />;
}
