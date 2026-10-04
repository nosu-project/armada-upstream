import { useEffect, useState } from "react";

import { holdCallMic, shouldHoldCallMic } from "@/lib/callMicHold";

/**
 * Hold the call's mic capture (see callMicHold.ts) for the component's life.
 * `true` once the room may connect: immediately where nothing is held, else
 * after the capture opens or fails. A refusal still lets the call connect,
 * muted, as it always has.
 */
export function useCallMicHold(): boolean {
  const [ready, setReady] = useState(() => !shouldHoldCallMic());

  useEffect(() => {
    if (!shouldHoldCallMic()) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    holdCallMic()
      .then((r) => {
        if (cancelled) r();
        else release = r;
      })
      .catch((err) => console.warn("call mic hold unavailable", err))
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      release?.();
    };
  }, []);

  return ready;
}
