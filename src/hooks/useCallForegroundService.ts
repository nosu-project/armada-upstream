import { useEffect, useRef } from "react";

import type { PluginListenerHandle } from "@capacitor/core";

import type { CallSummary } from "@/contexts/CallContext";
import { ArmadaCall, hasNativeCallService } from "@/lib/nativeCall";

/**
 * Mirror the active call into the Android ongoing-call notification. Two effects:
 * labels change mid-call, and one keyed on them would `stop()` on each relabel;
 * `start()` is an idempotent refresh natively. Android only.
 */
export function useCallForegroundService(
  active: boolean,
  summary: CallSummary | null,
  onHangup: () => void,
) {
  const title = summary?.title;
  const subtitle = summary?.subtitle;
  const icon = summary?.icon;

  // The fallback label covers the gap before the room registers its summary.
  useEffect(() => {
    if (!active || !hasNativeCallService()) return;
    ArmadaCall.start({ title: title ?? "Voice call", text: subtitle ?? "", icon }).catch((err) => {
      console.warn("[native-call] Could not post the ongoing call notification:", err);
    });
  }, [active, title, subtitle, icon]);

  useEffect(() => {
    if (!active || !hasNativeCallService()) return;
    return () => {
      ArmadaCall.stop().catch((err) => {
        console.warn("[native-call] Could not clear the ongoing call notification:", err);
      });
    };
  }, [active]);

  // The hang-up button, registered once and dispatched via a ref so no tap lands
  // during a re-registration.
  const hangupRef = useRef(onHangup);
  hangupRef.current = onHangup;
  useEffect(() => {
    if (!hasNativeCallService()) return;
    let handle: PluginListenerHandle | undefined;
    let cancelled = false;
    ArmadaCall.addListener("hangup", () => hangupRef.current())
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
}
