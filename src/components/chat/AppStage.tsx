import { useEffect, useRef } from "react";

import { useApps } from "@/hooks/useApps";
import { appScopeKey, type AppScope } from "@/contexts/AppsContext";

/**
 * Top-of-chat slot the active app's stage portals into when an app is open in
 * *this* scope. Renders nothing otherwise.
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
