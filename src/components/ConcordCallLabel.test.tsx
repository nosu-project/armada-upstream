/**
 * The Concord call bar's title must return you to the call.
 *
 * The NIP-29 and DM rooms have always rendered their bar title as a button
 * wired to the same navigate handler they register as `focusActiveCall`, so
 * clicking "#general" from anywhere in the app jumps back to the call. The
 * Concord room rendered its title as a plain `<span>`: it looked identical but
 * did nothing, leaving the floating window's expand action as the only way
 * back once you'd navigated away.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConcordCallLabel } from "@/components/PersistentVoiceRoom";

// The module pulls in the mic noise-suppression worklet, which jsdom has no
// AudioWorkletNode for. Nothing here touches audio processing.
vi.mock("@/lib/voiceProcessor", () => ({ syncRnnoise: vi.fn() }));

describe("ConcordCallLabel", () => {
  it("returns to the call's channel when the title is activated", () => {
    // The handler the room also hands to `registerFocusActiveCall`.
    const focusActiveCall = vi.fn();
    render(<ConcordCallLabel community="Concord" channel="general" onFocus={focusActiveCall} />);

    const title = screen.getByRole("button", { name: /Concord\s*#general/ });
    fireEvent.click(title);

    expect(focusActiveCall).toHaveBeenCalledTimes(1);
  });

  it("is a native button, so Enter/Space activate it and it never submits a form", () => {
    render(<ConcordCallLabel community="Concord" channel="general" onFocus={vi.fn()} />);

    const title = screen.getByRole("button", { name: /Concord\s*#general/ });
    expect(title.tagName).toBe("BUTTON");
    expect(title).toHaveAttribute("type", "button");
  });
});
