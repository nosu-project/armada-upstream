import { useEffect, useRef } from "react";

import type { PluginListenerHandle } from "@capacitor/core";

import type { CallSummary } from "@/contexts/CallContext";
import { ArmadaCall, hasNativeCallService } from "@/lib/nativeCall";

/**
 * Mirror the active call into the Android ongoing-call notification.
 *
 * Two effects rather than one, deliberately: the labels change several times
 * during a call (the group's metadata lands, a DM peer's kind-0 resolves), and
 * a single effect keyed on them would run its cleanup — the `stop()` — on every
 * relabel, blinking the notification away and back. So the lifecycle effect
 * depends only on `active`, and the label effect only ever calls `start()`,
 * which the native side treats as an idempotent refresh.
 *
 * No-ops everywhere but Android; see `hasNativeCallService`.
 */
export function useCallForegroundService(
  active: boolean,
  summary: CallSummary | null,
  onHangup: () => void,
) {
  const title = summary?.title;
  const subtitle = summary?.subtitle;

  // Post/refresh. The fallback label covers the window between joining and the
  // connected room registering its summary, which is where a user backgrounding
  // the app immediately would otherwise see nothing.
  useEffect(() => {
    if (!active || !hasNativeCallService()) return;
    ArmadaCall.start({ title: title ?? "Voice call", text: subtitle ?? "" }).catch((err) => {
      console.warn("[native-call] Could not post the ongoing call notification:", err);
    });
  }, [active, title, subtitle]);

  // Teardown, on the call ending (or the provider unmounting) and nothing else.
  useEffect(() => {
    if (!active || !hasNativeCallService()) return;
    return () => {
      ArmadaCall.stop().catch((err) => {
        console.warn("[native-call] Could not clear the ongoing call notification:", err);
      });
    };
  }, [active]);

  // The notification's "Leave" button. Registered once and dispatched through a
  // ref so a new `onHangup` identity (leaveCall is stable, but callers needn't
  // guarantee that) never costs a listener re-registration — during which a tap
  // would land on nothing.
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
