import { useCallback, useEffect, useState } from "react";

import type { PluginListenerHandle } from "@capacitor/core";

import { NO_CALL_ROUTES, type CallRoutesSnapshot } from "@/lib/callRoutes";
import { ArmadaCall, hasNativeCallService } from "@/lib/nativeCall";

/**
 * The Android call's output routes, live. Mount inside a call: the native
 * selector only watches between the plugin's start() and stop().
 */
export function useCallRoutes(): CallRoutesSnapshot & { select: (id: number) => Promise<boolean> } {
  const [snapshot, setSnapshot] = useState<CallRoutesSnapshot>(NO_CALL_ROUTES);

  useEffect(() => {
    if (!hasNativeCallService()) return;
    let cancelled = false;
    let handle: PluginListenerHandle | undefined;
    ArmadaCall.listRoutes()
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch(() => {});
    ArmadaCall.addListener("routesChanged", (s) => {
      if (!cancelled) setSnapshot(s);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  const select = useCallback(async (id: number) => {
    try {
      const { ok } = await ArmadaCall.selectRoute({ id });
      // The change event follows; this keeps the check mark from lagging a beat.
      if (ok) setSnapshot(await ArmadaCall.listRoutes());
      return ok;
    } catch {
      return false;
    }
  }, []);

  return { ...snapshot, select };
}
