import { useEffect, useRef } from "react";

import { useCall } from "@/hooks/useCall";

/**
 * The top-of-chat host into which the active call's stage portals. A chat
 * surface renders this when its conversation matches the active call
 * (`active`), registering its DOM node as the stage slot; CallProvider then
 * reparents its stable stage host (where the persistent `CallStage` lives)
 * into it. When not active it renders nothing — the stage stays mounted but
 * parked off-DOM, so navigating away never tears down video subscriptions.
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
