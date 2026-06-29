import { useEffect, useRef } from "react";

import { useApps } from "@/hooks/useApps";
import { appScopeKey, type AppScope } from "@/contexts/AppsContext";

/**
 * The top-of-chat host into which the active app's stage portals. A chat
 * surface renders this for its scope; when an app is open in *this* scope it
 * registers its DOM node as the stage slot and the persistent `RunningApp`
 * (which owns the coordination session) portals into it. Renders nothing when
 * no app is open here.
 */
export function AppStageSlot({ scope }: { scope: AppScope }) {
  const { activeApp, registerAppStageSlot } = useApps();
  const ref = useRef<HTMLDivElement | null>(null);

  const active = Boolean(activeApp && appScopeKey(activeApp.scope) === appScopeKey(scope));

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    return registerAppStageSlot(el);
  }, [active, registerAppStageSlot]);

  if (!active) return null;
  return <div ref={ref} className="shrink-0" />;
}
