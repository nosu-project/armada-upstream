import { act, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CallProvider } from "./CallProvider";
import { useCall } from "@/hooks/useCall";

import type { CallContextType } from "@/contexts/CallContext";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));

// The LiveKit half of the stack is loaded lazily on join and is irrelevant here.
vi.mock("@/components/PersistentVoiceRoom", () => ({ default: () => null }));

// Stand in for the draggable desktop window: registers its body as the floating
// host exactly as the real one does, so the stage genuinely reparents.
vi.mock("@/components/chat/FloatingCallStage", () => ({
  FloatingCallStage: ({
    registerSlot,
  }: {
    registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      registerSlot(el, "desktop");
      return () => registerSlot(null, "desktop");
    }, [registerSlot]);
    return <div data-testid="floating-window" ref={ref} />;
  },
}));

// Only one floating destination ever registers; this suite exercises desktop.
vi.mock("@/components/chat/MobileCallPreview", () => ({ MobileCallPreview: () => null }));

/** Mirrors CallStageSlot: registers a normal slot only while `active`. */
function StageSlot({ active }: { active: boolean }) {
  const { registerCallStageSlot } = useCall();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    return registerCallStageSlot(el);
  }, [active, registerCallStageSlot]);
  if (!active) return null;
  return <div data-testid="stage-slot" ref={ref} />;
}

/**
 * Mount the provider with an active call and hand the test a live handle on the
 * call context, plus a setter for whether the current route is the call's own
 * channel (i.e. whether a normal stage slot is registered).
 */
async function setup() {
  const handle: { call: CallContextType; setOnCallChannel: (v: boolean) => void } = {
    call: null as unknown as CallContextType,
    setOnCallChannel: () => {},
  };

  function Probe() {
    const call = useCall();
    const [onCallChannel, setOnCallChannel] = useState(false);
    handle.call = call;
    handle.setOnCallChannel = setOnCallChannel;
    return <StageSlot active={onCallChannel} />;
  }

  render(
    <CallProvider>
      <Probe />
    </CallProvider>,
  );

  // Joining opens the docked stage (CallProvider.joinCall), which is the
  // starting point every scenario below builds on. Flush the lazy voice-room
  // chunk it mounts so its Suspense resolution lands inside act().
  await act(async () => {
    handle.call.joinCall("wss://relay.example", "group-1");
  });
  return handle;
}

describe("CallProvider stage visibility", () => {
  it("tracks and toggles the docked stage while on the call's channel", async () => {
    const h = await setup();
    act(() => h.setOnCallChannel(true));

    expect(h.call.stageVisible).toBe(true);
    expect(h.call.stageOpen).toBe(true);
    // The call's channel is on screen, so the floating window must not be.
    expect(screen.queryByTestId("floating-window")).toBeNull();

    act(() => h.call.toggleStage());
    expect(h.call.stageOpen).toBe(false);
    expect(h.call.stageVisible).toBe(false);
    expect(h.call.floatingHidden).toBe(false);

    act(() => h.call.toggleStage());
    expect(h.call.stageOpen).toBe(true);
    expect(h.call.stageVisible).toBe(true);
  });

  it("reports the floating window — not stageOpen — as visible off the call's channel", async () => {
    const h = await setup();

    expect(screen.getByTestId("floating-window")).toBeTruthy();
    expect(h.call.stageVisible).toBe(true);

    // A collapsed docked stage must not make a shown floating window read as
    // hidden: away from the call's channel, stageOpen describes nothing on
    // screen. (This is the state the old stageOpen-driven label got wrong.)
    act(() => h.call.setStageOpen(false));
    expect(h.call.stageVisible).toBe(true);
    expect(screen.getByTestId("floating-window")).toBeTruthy();
  });

  it("hides the floating window off the call's channel, preserving stageOpen", async () => {
    const h = await setup();
    expect(h.call.stageOpen).toBe(true);

    act(() => h.call.toggleStage());

    expect(h.call.floatingHidden).toBe(true);
    expect(h.call.stageVisible).toBe(false);
    expect(screen.queryByTestId("floating-window")).toBeNull();
    // The docked-stage preference is untouched — returning to the call's
    // channel must find the stage exactly as the user left it.
    expect(h.call.stageOpen).toBe(true);
  });

  it("restores a hidden floating window without navigating back to the call", async () => {
    const h = await setup();
    act(() => h.call.toggleStage());
    expect(screen.queryByTestId("floating-window")).toBeNull();

    act(() => h.call.toggleStage());

    expect(h.call.floatingHidden).toBe(false);
    expect(h.call.stageVisible).toBe(true);
    expect(screen.getByTestId("floating-window")).toBeTruthy();
    expect(h.call.stageOpen).toBe(true);
  });
});
