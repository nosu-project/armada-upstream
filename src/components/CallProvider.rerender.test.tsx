/**
 * The `CallContext` / `VoiceActivityContext` split.
 *
 * `speakingPubkeys` moves on every LiveKit `ActiveSpeakersChanged` — several
 * times a second while anyone is talking — and `mutedPubkeys` /
 * `voiceRoomPubkeys` on every track and participant event. The other ~22
 * fields of the call context (the active call, join/leave, stage and slot
 * registration) change at human speed.
 *
 * Held in one context, a speaker starting to talk invalidated all of them for
 * every `useCall()` consumer, including `PersistentVoiceRoom` — which reads
 * `useCall()` only to obtain setters, and so re-rendered and re-ran its effects
 * on every frame of its OWN reports.
 *
 * These tests pin the two halves of the split: the setters stay on a context
 * that voice traffic does not touch, and the values reach the components that
 * render them.
 */

import { act, render } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it, vi } from "vitest";

import { CallProvider } from "@/components/CallProvider";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";

// No signed-in user and no active call: the lazy voice room, the foreground
// service and the floating stages all stay unmounted, leaving just the
// providers under test.
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useCallForegroundService", () => ({ useCallForegroundService: () => {} }));

describe("CallProvider — voice activity is a separate context", () => {
  it("a speaker change does not re-render useCall() consumers", async () => {
    let callRenders = 0;
    let activityRenders = 0;
    let report: ((pubkeys: Set<string>) => void) | undefined;

    const CallConsumer = memo(function CallConsumer() {
      callRenders++;
      const { activeCall, setSpeakingPubkeys } = useCall();
      report = setSpeakingPubkeys;
      return <span>{String(activeCall)}</span>;
    });

    const ActivityConsumer = memo(function ActivityConsumer() {
      activityRenders++;
      const { speakingPubkeys } = useVoiceActivity();
      return <span>{speakingPubkeys.size}</span>;
    });

    render(
      <CallProvider>
        <CallConsumer />
        <ActivityConsumer />
      </CallProvider>,
    );

    const callBaseline = callRenders;
    const activityBaseline = activityRenders;

    // Five distinct speaker sets, as a live room would report.
    for (let i = 0; i < 5; i++) {
      await act(async () => report?.(new Set([`pk${i}`])));
    }

    expect(callRenders, "useCall() must not see voice traffic").toBe(callBaseline);
    expect(activityRenders, "useVoiceActivity() must see it").toBe(activityBaseline + 5);
  });

  it("an unchanged speaker set re-renders nothing", async () => {
    let activityRenders = 0;
    let report: ((pubkeys: Set<string>) => void) | undefined;

    const ActivityConsumer = memo(function ActivityConsumer() {
      activityRenders++;
      const { speakingPubkeys } = useVoiceActivity();
      const { setSpeakingPubkeys } = useCall();
      report = setSpeakingPubkeys;
      return <span>{speakingPubkeys.size}</span>;
    });

    render(
      <CallProvider>
        <ActivityConsumer />
      </CallProvider>,
    );

    await act(async () => report?.(new Set(["a", "b"])));
    const afterFirst = activityRenders;

    // The equality guard in CallProvider must still hold — a room reporting the
    // same set repeatedly (the common case between speaker changes) is free.
    for (let i = 0; i < 5; i++) {
      await act(async () => report?.(new Set(["a", "b"])));
    }

    expect(activityRenders).toBe(afterFirst);
  });
});
