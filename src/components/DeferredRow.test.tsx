import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredRow } from "@/components/DeferredRow";

/**
 * The viewport gate behind MemberList's roster and DMsPage's conversation list.
 * A mount counter stands in for the per-row query hooks both consumers pay for,
 * so the assertions are about WHEN children are built.
 */

const observers: MockIO[] = [];
class MockIO {
  els = new Set<Element>();
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.els.add(el);
  }
  unobserve(el: Element) {
    this.els.delete(el);
  }
  disconnect() {
    this.els.clear();
  }
  takeRecords() {
    return [];
  }
  fire() {
    const entries = [...this.els].map(
      (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
    );
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

function fireAll() {
  act(() => {
    for (const io of [...observers]) io.fire();
  });
}

const mounted = vi.fn();
function Row({ label }: { label: string }) {
  mounted(label);
  return <div data-testid="row">{label}</div>;
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIO);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DeferredRow", () => {
  it("renders children immediately when inactive, observing nothing", () => {
    render(
      <DeferredRow active={false} minHeight={48}>
        <Row label="a" />
      </DeferredRow>,
    );

    expect(screen.getAllByTestId("row")).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(0);
  });

  it("holds a placeholder of the given height until it intersects", () => {
    const { container } = render(
      <DeferredRow active minHeight={68}>
        <Row label="a" />
      </DeferredRow>,
    );

    expect(screen.queryByTestId("row")).toBeNull();
    expect(mounted).not.toHaveBeenCalled();
    const placeholder = container.querySelector("[aria-hidden]") as HTMLElement;
    expect(placeholder.style.height).toBe("68px");

    fireAll();
    expect(screen.getAllByTestId("row")).toHaveLength(1);
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });

  it("latches: once shown it stops observing and stays mounted", () => {
    render(
      <DeferredRow active minHeight={48}>
        <Row label="a" />
      </DeferredRow>,
    );

    fireAll();
    expect(mounted).toHaveBeenCalledTimes(1);
    // The observer was disconnected on the first hit, so a later scroll can
    // neither re-fire it nor un-build the row.
    expect(observers[0].els.size).toBe(0);
    fireAll();
    expect(screen.getAllByTestId("row")).toHaveLength(1);
  });

  it("gates each row independently in a list", () => {
    const { rerender } = render(
      <>
        {["a", "b", "c"].map((label) => (
          <DeferredRow key={label} active minHeight={48}>
            <Row label={label} />
          </DeferredRow>
        ))}
      </>,
    );

    expect(observers).toHaveLength(3);
    expect(mounted).not.toHaveBeenCalled();

    // Only the middle row scrolls in.
    act(() => observers[1].fire());
    expect(mounted.mock.calls.map(([l]) => l)).toEqual(["b"]);

    // Turning the gate off (as a search does) reveals the rest with no scroll.
    rerender(
      <>
        {["a", "b", "c"].map((label) => (
          <DeferredRow key={label} active={false} minHeight={48}>
            <Row label={label} />
          </DeferredRow>
        ))}
      </>,
    );
    expect(screen.getAllByTestId("row")).toHaveLength(3);
  });
});
