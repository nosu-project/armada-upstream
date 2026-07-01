import { useEffect, useRef } from "react";

import { useCall } from "@/hooks/useCall";

/**
 * The top-of-chat host into which the active call's stage portals. A chat
 * surface renders this when its conversation matches the active call
 * (`active`), registering its DOM node as the stage slot; the persistent
 * `CallStage` (which lives in the LiveKitRoom) renders into it. When not active
 * it renders nothing, so non-matching surfaces never show the stage.
 *
 * Lives in its own module (not CallStage.tsx) so the pages that render the
 * slot don't pull the LiveKit SDK into their chunks — the stage itself is
 * loaded lazily with the rest of the voice stack on the first call join.
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
