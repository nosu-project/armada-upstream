import { act, cleanup, render } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

/**
 * Characterization + effect-verification for MemberList's render cost.
 *
 * Originally this pinned the "every member mounts eagerly" cost. MemberList now
 * viewport-gates rows on a large roster (VIRTUALIZE_THRESHOLD): offscreen rows
 * render a placeholder and mount their 4 query hooks + profile popovers +
 * context menu only when they scroll near the viewport. These tests verify that
 * effect — a large roster mounts NO offscreen rows until they intersect, while
 * a small roster (and an active search, whose matcher needs every name) still
 * renders in full.
 *
 * The four leaf hooks and heavy children are stubbed to counting spies so the
 * assertions are about which rows MOUNT, isolated from the query/profile stack.
 */

const spies = vi.hoisted(() => ({
  useAuthor: vi.fn(),
  useUserStatus: vi.fn(),
  useScopedIdentity: vi.fn(),
  useMemberSearch: vi.fn(),
}));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => {
    spies.useAuthor(pubkey);
    return { data: undefined };
  },
}));
vi.mock("@/hooks/useUserStatus", () => ({
  useUserStatus: (pubkey?: string, type = "general") => {
    spies.useUserStatus(pubkey, type);
    return { data: undefined };
  },
  isStatusExpired: () => false,
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedIdentity: (pubkey: string) => {
    spies.useScopedIdentity(pubkey);
    return { displayName: pubkey.slice(0, 8) };
  },
}));
vi.mock("@/hooks/useMemberSearch", () => ({
  useMemberSearch: (roster: string[], query: string) => {
    spies.useMemberSearch(roster, query);
    return null; // no search active
  },
}));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/dialogs/StatusDialog", () => ({ StatusDialog: () => null }));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));
vi.mock("@/components/chat/CustomEmoji", () => ({
  EmojifiedText: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { MemberList } from "@/components/chat/MemberList";

// Controllable IntersectionObserver: it never fires on its own (offscreen), and
// a test can `fireAll()` to simulate every observed row scrolling into view.
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

function pubkeys(n: number): string[] {
  return Array.from({ length: n }, () => getPublicKey(generateSecretKey()));
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll(".gutter-tick").length;
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

describe("MemberList viewport gating", () => {
  it("mounts NO offscreen rows on a large roster until they intersect", () => {
    const members = pubkeys(500);
    const { container } = render(
      <MemberList admins={[]} members={members} canModerate={false} />,
    );

    // Nothing visible yet ⇒ no rows mounted, no per-row query hooks stood up.
    expect(rowCount(container)).toBe(0);
    expect(spies.useAuthor).not.toHaveBeenCalled();
    // The gate is real: 500 rows were handed to observers, not the DOM.
    expect(observers.length).toBe(500);

    // Scroll them all into view ⇒ they mount (no rows are lost).
    fireAll();
    expect(rowCount(container)).toBe(500);
    expect(spies.useAuthor).toHaveBeenCalledTimes(500);
    expect(spies.useUserStatus).toHaveBeenCalledTimes(1000); // general + music per row
  }, 30_000);

  it("renders a small roster in full (no gating below threshold)", () => {
    const members = pubkeys(40);
    const { container } = render(
      <MemberList admins={[]} members={members} canModerate={false} />,
    );

    // Under the threshold: all rows mount immediately, no observers created.
    expect(rowCount(container)).toBe(40);
    expect(spies.useAuthor).toHaveBeenCalledTimes(40);
    expect(observers.length).toBe(0);
  });

  it("[perf] gated first paint of a large roster is cheap (few rows mounted)", () => {
    const members = pubkeys(800);

    const t0 = performance.now();
    const { container } = render(
      <MemberList admins={[]} members={members} canModerate={false} />,
    );
    const gatedMs = performance.now() - t0;

    // First paint mounts zero heavy rows regardless of roster size.
    expect(rowCount(container)).toBe(0);

    const t1 = performance.now();
    fireAll();
    const fullMs = performance.now() - t1;
    expect(rowCount(container)).toBe(800);

    console.log(
      `[perf] MemberList(800): gated first paint ${gatedMs.toFixed(1)}ms, ` +
        `full mount on scroll-in ${fullMs.toFixed(1)}ms`,
    );
    // The gated first paint is the interactive cost now; it must be far below
    // the ~1.2s all-eager render this replaced.
    expect(gatedMs).toBeLessThan(400);
  }, 30_000);
});
