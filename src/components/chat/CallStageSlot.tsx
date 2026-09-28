import { useEffect, useRef } from "react";

import { useCall } from "@/hooks/useCall";

/**
 * Top-of-chat slot CallProvider reparents the persistent stage host into when
 * `active`. Separate module so pages rendering it don't pull in LiveKit.
 */
export function CallStageSlot({ active }: { active: boolean }) {
  const { registerCallStageSlot } = useCall();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    return registerCallStageSlot(el);
  }, [active, registerCallStageSlot]);

  if (!active) return null;
  return <div ref={ref} className="shrink-0" />;
}
