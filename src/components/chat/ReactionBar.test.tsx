import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReactionBar } from "./ReactionBar";

import type { ReactionTally } from "@/hooks/useReactions";

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsTouch: () => false }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "Ana" }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <>{name}</> }));

const tally = { key: "👍", count: 1, pubkeys: ["a".repeat(64)], mine: false } as unknown as ReactionTally;

function renderBar() {
  render(
    <>
      <button type="button">before</button>
      <ReactionBar tallies={[tally]} canReact onReact={() => {}} />
      <button type="button">after</button>
    </>,
  );
  return screen.getByRole("button", { name: /👍/ });
}

describe("ReactionPill keyboard focus", () => {
  it("opens the detail without taking focus from the pill", async () => {
    const pill = renderBar();
    await act(async () => {
      pill.focus();
    });
    expect(await screen.findByText("1 reaction")).toBeInTheDocument();
    expect(document.activeElement).toBe(pill);
  });

  it("closes on Escape and leaves focus on the pill", async () => {
    const pill = renderBar();
    await act(async () => {
      pill.focus();
    });
    await screen.findByText("1 reaction");
    await act(async () => {
      fireEvent.keyDown(pill, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText("1 reaction")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(pill);
  });

  it("closes when focus moves on from the pill", async () => {
    const pill = renderBar();
    await act(async () => {
      pill.focus();
    });
    await screen.findByText("1 reaction");
    await act(async () => {
      screen.getByRole("button", { name: "after" }).focus();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText("1 reaction")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
  });

  it("an Escape typed elsewhere closes a hover-opened detail without taking focus", async () => {
    render(
      <>
        <textarea aria-label="composer" />
        <ReactionBar tallies={[tally]} canReact onReact={() => {}} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "composer" });
    const pill = screen.getByRole("button", { name: /👍/ });
    composer.focus();
    await act(async () => {
      fireEvent.pointerEnter(pill, { pointerType: "mouse" });
      await new Promise((r) => setTimeout(r, 600));
    });
    await screen.findByText("1 reaction");
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText("1 reaction")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(composer);
  });

  async function hoverOpenWithComposer(onComposerKeyDown: (e: React.KeyboardEvent) => void) {
    render(
      <>
        <textarea aria-label="composer" onKeyDown={onComposerKeyDown} />
        <ReactionBar tallies={[tally]} canReact onReact={() => {}} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    await act(async () => {
      fireEvent.pointerEnter(screen.getByRole("button", { name: /👍/ }), { pointerType: "mouse" });
      await new Promise((r) => setTimeout(r, 600));
    });
    await screen.findByText("1 reaction");
    return composer;
  }

  it("one Escape closes a hover-opened detail AND reaches the composer unprevented", async () => {
    // The composer drops its reply target only on an Escape nothing else claimed.
    const cancelReply = vi.fn();
    const composer = await hoverOpenWithComposer((e) => {
      if (e.key === "Escape" && !e.defaultPrevented) cancelReply();
    });
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText("1 reaction")).not.toBeInTheDocument();
    expect(cancelReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(composer);
  });

  it("still lets a native listener on the composer claim that Escape", async () => {
    const cancelReply = vi.fn();
    const composer = await hoverOpenWithComposer((e) => {
      if (e.key === "Escape" && !e.defaultPrevented) cancelReply();
    });
    // An open autocomplete prevents Escape from its own textarea listener.
    const claim = (e: Event) => e.preventDefault();
    composer.addEventListener("keydown", claim);
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 10));
    });
    composer.removeEventListener("keydown", claim);
    expect(screen.queryByText("1 reaction")).not.toBeInTheDocument();
    expect(cancelReply).not.toHaveBeenCalled();
  });
});
