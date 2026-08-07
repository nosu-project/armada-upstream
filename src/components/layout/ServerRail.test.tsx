// Wiring test for the rail's drag-to-reorder/fold gesture: mounts the real
// ServerRail (data hooks mocked), fakes slot geometry (jsdom has no layout),
// and drives the pointer-event flow to assert drops land in the layout.
import { act, render } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultConfig, type AppConfig } from "@/contexts/AppContext";

import { ServerRail } from "./ServerRail";

// ─── Mocks: data hooks (the rail's view data, all inert) ─────────────────

vi.mock("@/components/dialogs/AddDialog", () => ({ AddDialog: () => null }));
vi.mock("@/hooks/useCall", () => ({ useCall: () => ({ activeCall: null }) }));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "test-pubkey" } }),
}));
// Per-peer DM unread, settable per test (drives the pinned-DM badge).
const dmUnread = vi.hoisted(() => ({}) as Record<string, boolean>);
vi.mock("@/hooks/useDirectMessages", () => ({
  useHasUnreadDMs: () => false,
  useDmPeerUnread: (peer?: string) => Boolean(peer && dmUnread[peer]),
}));
// Profile metadata for DMs on the rail, settable per test.
const authorNames = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => ({
    data: pubkey && authorNames[pubkey] ? { metadata: { name: authorNames[pubkey] } } : undefined,
  }),
}));
vi.mock("@/hooks/useMeshTransport", () => ({
  useMeshTransport: () => ({ mesh: { available: false } }),
}));
vi.mock("@/hooks/useRelayGroups", () => ({ useRelayGroups: () => ({ data: [] }) }));
vi.mock("@/hooks/useRelayInfo", () => ({ useRelayInfo: () => ({ data: undefined }) }));
// Per-relay unread state, settable per test (drives badges + folder rollups).
const relayUnread = vi.hoisted(
  () => ({}) as Record<string, { anyUnread: boolean; anyMention: boolean }>,
);
vi.mock("@/hooks/useRelayUnread", () => ({
  useRelayUnread: (url?: string) =>
    (url && relayUnread[url]) || { anyUnread: false, anyMention: false },
}));
// The kind 10009 write the rail makes to keep relay order in sync. Hoisted so
// a test can assert what did — and didn't — reach the user's server list.
const updateGroupList = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/hooks/useUserGroupList", () => ({
  useUpdateUserGroupList: () => ({ mutateAsync: updateGroupList }),
}));
// The rail's NIP-29 half comes from the kind 10009 list. `extraServers` lets a
// suite add members beyond the three base ones.
vi.mock("@/hooks/useNip29Servers", () => ({
  useNip29Servers: () => [
    "wss://a.example/",
    "wss://b.example/",
    "wss://c.example/",
    ...extraServers,
  ],
}));
vi.mock("@/concord-v2/hooks/useCommunityList2", () => ({
  useCommunity2: () => undefined,
  useLiveCommunities2: () => [],
  useIsExcluded2: () => false,
}));
vi.mock("@/concord-v2/hooks/useControlPlane2", () => ({
  useChannels2: () => [],
  useControlFold2: () => ({ data: undefined }),
}));
vi.mock("@/concord-v2/hooks/useConcord2Unread", () => ({
  useConcord2Unread: () => ({ byChannel: {} }),
}));
vi.mock("@/concord-v2/hooks/useDecryptedImage2", () => ({
  useDecryptedImage2: () => undefined,
}));
vi.mock("@/lib/haptics", () => ({ impact: vi.fn() }));

const RELAY_A = "wss://a.example/";
const RELAY_B = "wss://b.example/";
const RELAY_C = "wss://c.example/";

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return {
    ...actual,
    normalizeRelayUrl: (u: string) => u,
    relayToRouteParam: (u: string) => encodeURIComponent(u),
  };
});

// Mutable config store backing the mocked AppContext.
let config: AppConfig;
// Servers beyond the three base ones, as if they were in the 10009 list.
let extraServers: string[] = [];
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config,
    updateConfig: (updater: (c: AppConfig) => AppConfig) => {
      config = updater(config);
    },
  }),
}));

// ─── Fake geometry: sequential 48px slots at a 68px pitch ────────────────
//
// jsdom computes no layout, so getBoundingClientRect is patched to give every
// [data-rail-anchor] element a viewport rect derived from its DOM order.
const SLOT_TOP = 100;
const PITCH = 68;
const SIZE = 48;

function installGeometry() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const anchored = Array.from(document.querySelectorAll("[data-rail-anchor]"));
    const idx = anchored.indexOf(el);
    const top = idx === -1 ? 0 : SLOT_TOP + idx * PITCH;
    const height = idx === -1 ? 800 : SIZE;
    return {
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 72,
      width: 72,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Viewport Y of the center of the nth anchored slot (DOM order). */
const slotCenter = (idx: number) => SLOT_TOP + idx * PITCH + SIZE / 2;

// ─── Pointer-event helpers (jsdom has no PointerEvent) ──────────────────

function firePointer(
  target: EventTarget,
  type: string,
  opts: { x: number; y: number; pointerId?: number; pointerType?: string; button?: number },
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x,
    clientY: opts.y,
    button: opts.button ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: opts.pointerId ?? 1 });
  Object.defineProperty(ev, "pointerType", { value: opts.pointerType ?? "mouse" });
  act(() => {
    target.dispatchEvent(ev);
  });
}

/** Mouse-drag the element at anchor `from` and drop at viewport y `toY`. */
async function mouseDrag(fromAnchor: string, toY: number) {
  const el = document.querySelector(`[data-rail-anchor="${fromAnchor}"]`);
  expect(el, `element with anchor ${fromAnchor}`).toBeTruthy();
  const anchored = Array.from(document.querySelectorAll("[data-rail-anchor]"));
  const startY = slotCenter(anchored.indexOf(el!));
  firePointer(el!, "pointerdown", { x: 36, y: startY });
  // Hold through the long-press threshold (~300ms) to pick up…
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
  // …drag to the target…
  firePointer(window, "pointermove", { x: 36, y: toY });
  // …and drop.
  firePointer(window, "pointerup", { x: 36, y: toY });
}

function renderRail(initialEntries: string[] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        {/* jsdom's matchMedia reports matches:false, so the layout reads as the
            desktop side-by-side one — the shell variant is the live rail there. */}
        <ServerRail variant="shell" />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** The active-route blade (left bar) inside an anchored rail entry, if lit. */
function bladeIsLit(anchor: string): boolean {
  const el = document.querySelector(`[data-rail-anchor="${anchor}"]`);
  expect(el, `element with anchor ${anchor}`).toBeTruthy();
  const blade = Array.from(el!.querySelectorAll("span")).find((s) =>
    s.className.includes("w-[3px]"),
  );
  return blade !== undefined && blade.className.includes("h-12");
}

describe("ServerRail drag wiring", () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    extraServers = [];
    config = { ...defaultConfig, railLayout: [], railOrder: [], railOpenFolders: [] };
    restoreGeometry = installGeometry();
    return () => restoreGeometry();
  });

  it("drops one server onto another to create a folder", async () => {
    renderRail();
    // Slots (DOM order): 0=A, 1=B, 2=C.
    await mouseDrag(`item:${RELAY_A}`, slotCenter(1)); // middle of B → combine
    expect(config.railLayout).toEqual([
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_B, RELAY_A] },
      { type: "item", key: RELAY_C },
    ]);
  });

  it("drops a server onto a collapsed folder to move it inside", async () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    renderRail();
    // Slots (DOM order): 0=folder f (collapsed), 1=C.
    await mouseDrag(`item:${RELAY_C}`, slotCenter(0)); // middle of the folder → into it
    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B, RELAY_C] },
    ]);
  });

  it("accepts a drop near the folder's edge, not just its center", async () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    renderRail();
    await mouseDrag(`item:${RELAY_C}`, SLOT_TOP + 2); // 2px into the folder's rect
    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B, RELAY_C] },
    ]);
  });

  it("drops between entries to reorder", async () => {
    renderRail();
    // Drop A into the gap just above C (below B's center, above C's top).
    await mouseDrag(`item:${RELAY_A}`, SLOT_TOP + 2 * PITCH - 6);
    expect(config.railOrder).toEqual([RELAY_B, RELAY_A, RELAY_C]);
  });

  it("drags an item out of an expanded folder to dissolve a 2-item folder", async () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    config.railOpenFolders = ["f"];
    renderRail();
    // Slots (DOM order): 0=folder header, 1=A (child), 2=B (child), 3=C.
    await mouseDrag(`item:${RELAY_A}`, SLOT_TOP + 4 * PITCH); // below everything → end
    expect(config.railLayout).toEqual([
      { type: "item", key: RELAY_B },
      { type: "item", key: RELAY_C },
      { type: "item", key: RELAY_A },
    ]);
  });

  it("mouse press-and-hold picks up: cursor flips to grabbing, drop applies", async () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0) });
    // No movement — the long-press threshold (~300ms) alone fires the pickup…
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    // …and the entry reads as held: the global grabbing cursor plus the
    // full-viewport cursor overlay (what actually flips the cursor in
    // Chromium while the button is down).
    expect(document.body.style.cursor).toBe("grabbing");
    expect(document.querySelector("[data-rail-drag-overlay]")).toBeTruthy();
    firePointer(window, "pointermove", { x: 36, y: slotCenter(1) });
    firePointer(window, "pointerup", { x: 36, y: slotCenter(1) });
    expect(document.body.style.cursor).toBe("");
    expect(document.querySelector("[data-rail-drag-overlay]")).toBeNull();
    expect(config.railLayout).toEqual([
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_B, RELAY_A] },
      { type: "item", key: RELAY_C },
    ]);
  });

  it("mouse movement alone never picks up, and doesn't cancel the hold", async () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0) });
    // Move well past any distance threshold before the long press fires…
    firePointer(window, "pointermove", { x: 36, y: slotCenter(2) });
    expect(document.body.style.cursor).toBe(""); // …no pickup from movement…
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    // …but the hold still completes, picking up at the cursor's position
    // (over C, not at the press point over A).
    expect(document.body.style.cursor).toBe("grabbing");
    firePointer(window, "pointerup", { x: 36, y: slotCenter(2) });
    expect(config.railLayout).toEqual([
      { type: "item", key: RELAY_B },
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_C, RELAY_A] },
    ]);
  });

  it("a quick mouse drag released before the long press changes nothing", () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0) });
    firePointer(window, "pointermove", { x: 36, y: slotCenter(1) });
    firePointer(window, "pointerup", { x: 36, y: slotCenter(1) });
    expect(document.body.style.cursor).toBe("");
    expect(config.railLayout).toEqual([]); // nothing persisted
  });

  it("mouse press-and-hold released in place aborts, so the tap still navigates", async () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0) });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    firePointer(window, "pointerup", { x: 36, y: slotCenter(0) });
    expect(document.body.style.cursor).toBe("");
    // A pickup that never travelled is a long-held TAP, not a reorder: it must
    // NOT apply a (no-op) drop or suppress the navigation click. Nothing is
    // persisted (no fold, no materialised order) and the click navigates.
    expect(config.railLayout.filter((n) => n.type === "folder")).toEqual([]);
    expect(config.railOrder).toEqual([]);
  });

  it("touch long-press picks up, claims touchmove from the browser, and drops", async () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0), pointerType: "touch" });
    // Long-press threshold (~300ms) fires the pickup.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    // With the drag live, raw touchmove must be canceled — otherwise the
    // browser pans the rail (touch-action was resolved at gesture start)
    // and kills the drag with pointercancel. The canceller lives permanently
    // on the nav (Chrome ignores blocking listeners attached mid-gesture),
    // and touch events keep targeting the touchstart element, so dispatch
    // there and let it bubble through the rail.
    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(touchMove);
    });
    expect(touchMove.defaultPrevented).toBe(true);
    firePointer(window, "pointermove", { x: 36, y: slotCenter(1), pointerType: "touch" });
    firePointer(window, "pointerup", { x: 36, y: slotCenter(1), pointerType: "touch" });
    expect(config.railLayout).toEqual([
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_B, RELAY_A] },
      { type: "item", key: RELAY_C },
    ]);
  });

  it("pointercancel aborts the drag without applying a drop", async () => {
    renderRail();
    const el = document.querySelector(`[data-rail-anchor="item:${RELAY_A}"]`)!;
    firePointer(el, "pointerdown", { x: 36, y: slotCenter(0), pointerType: "touch" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    firePointer(window, "pointermove", { x: 36, y: slotCenter(2), pointerType: "touch" });
    firePointer(window, "pointercancel", { x: 36, y: slotCenter(2), pointerType: "touch" });
    expect(config.railLayout).toEqual([]); // nothing persisted
  });
});

describe("ServerRail active-route blade", () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    extraServers = [];
    config = { ...defaultConfig, railLayout: [], railOrder: [], railOpenFolders: [] };
    restoreGeometry = installGeometry();
    return () => restoreGeometry();
  });

  const ROOM_ROUTE = `/s/${encodeURIComponent(RELAY_A)}/room1`;

  it("lights the collapsed folder's blade when the open room's server is inside", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    renderRail([ROOM_ROUTE]);
    expect(bladeIsLit("folder:f")).toBe(true);
    expect(bladeIsLit(`item:${RELAY_C}`)).toBe(false);
  });

  it("lights the child's blade (not the header's) when the folder is open", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    config.railOpenFolders = ["f"];
    renderRail([ROOM_ROUTE]);
    expect(bladeIsLit(`item:${RELAY_A}`)).toBe(true);
    expect(bladeIsLit(`item:${RELAY_B}`)).toBe(false);
    expect(bladeIsLit("folder:f")).toBe(false);
  });
});

describe("ServerRail folder notification rollup", () => {
  let restoreGeometry: () => void;

  // Five members: D and E come from the user's kind 10009 list; the collapsed
  // mini grid only shows the first four, so activity on E must surface via the
  // folder badge.
  const RELAY_D = "wss://d.example/";
  const RELAY_E = "wss://e.example/";

  beforeEach(() => {
    extraServers = [RELAY_D, RELAY_E];
    config = {
      ...defaultConfig,
      railLayout: [
        { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B, RELAY_C, RELAY_D, RELAY_E] },
      ],
      railOrder: [],
      railOpenFolders: [],
    };
    for (const key of Object.keys(relayUnread)) delete relayUnread[key];
    restoreGeometry = installGeometry();
    return () => restoreGeometry();
  });

  const folderBtn = () => document.querySelector('[data-rail-anchor="folder:f"]')!;

  it("shows a mention badge on the collapsed folder for a member beyond the grid", () => {
    relayUnread[RELAY_E] = { anyUnread: true, anyMention: true };
    renderRail();
    expect(folderBtn().querySelector('[aria-label="You were mentioned"]')).toBeTruthy();
  });

  it("shows an unread dot on the collapsed folder for plain unread", () => {
    relayUnread[RELAY_E] = { anyUnread: true, anyMention: false };
    renderRail();
    expect(folderBtn().querySelector('[aria-label="Unread messages"]')).toBeTruthy();
    expect(folderBtn().querySelector('[aria-label="You were mentioned"]')).toBeNull();
  });

  it("shows nothing when no member has activity", () => {
    renderRail();
    expect(folderBtn().querySelector('[aria-label="Unread messages"]')).toBeNull();
    expect(folderBtn().querySelector('[aria-label="You were mentioned"]')).toBeNull();
  });
});

// ─── DMs pinned to the rail ─────────────────────────────────────────────
//
// A DM is on the rail because the user put it there and nowhere else records
// that, so the arrangement is its whole source of truth: a `dm:` key IS the
// item. These assert it renders from the layout alone, points at the peer's
// thread, and is otherwise an ordinary rail item.

describe("ServerRail DMs", () => {
  const PEER = "a".repeat(64);
  const DM_KEY = `dm:${PEER}`;
  const DM_ANCHOR = `item:${DM_KEY}`;
  const dmHref = `/dm/${nip19.npubEncode(PEER)}`;

  let restoreGeometry: () => void;

  beforeEach(() => {
    extraServers = [];
    // The DM is the only thing STORED; the three servers are appended live, so
    // this also covers a key arriving from another device's arrangement.
    config = {
      ...defaultConfig,
      railLayout: [{ type: "item", key: DM_KEY }],
      railOrder: [],
      railOpenFolders: [],
    };
    for (const key of Object.keys(dmUnread)) delete dmUnread[key];
    for (const key of Object.keys(authorNames)) delete authorNames[key];
    updateGroupList.mockClear();
    restoreGeometry = installGeometry();
    return () => restoreGeometry();
  });

  const dmBtn = () => document.querySelector(`[data-rail-anchor="${DM_ANCHOR}"]`)!;

  it("renders an icon for a DM key and links to the peer's thread", () => {
    authorNames[PEER] = "Sam";
    renderRail();
    expect(dmBtn()).toBeTruthy();
    // The thread, not `/dm` — on mobile the list is the same route's other
    // state, which is exactly what the icon exists to skip.
    expect(dmBtn().getAttribute("href")).toBe(dmHref);
    expect(dmBtn().getAttribute("aria-label")).toBe("Sam");
  });

  it("lights the active blade when that thread is open", () => {
    renderRail([dmHref]);
    expect(bladeIsLit(DM_ANCHOR)).toBe(true);
    expect(bladeIsLit(`item:${RELAY_A}`)).toBe(false);
  });

  it("stays lit inside the thread's permalink route", () => {
    renderRail([`${dmHref}/m/abc123`]);
    expect(bladeIsLit(DM_ANCHOR)).toBe(true);
  });

  it("badges unread messages, and drops the badge while the thread is open", () => {
    dmUnread[PEER] = true;
    const { unmount } = renderRail();
    expect(dmBtn().querySelector('[aria-label="Unread messages"]')).toBeTruthy();
    unmount();
    renderRail([dmHref]);
    expect(dmBtn().querySelector('[aria-label="Unread messages"]')).toBeNull();
  });

  it("folders with a community like any other item", async () => {
    renderRail();
    // Slots (DOM order): 0=DM, 1=A, 2=B, 3=C.
    await mouseDrag(DM_ANCHOR, slotCenter(1)); // middle of A → combine
    expect(config.railLayout).toEqual([
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_A, DM_KEY] },
      { type: "item", key: RELAY_B },
      { type: "item", key: RELAY_C },
    ]);
  });

  it("never sends the DM key to the kind 10009 server list", async () => {
    renderRail();
    await mouseDrag(DM_ANCHOR, slotCenter(1));
    expect(updateGroupList).toHaveBeenCalledWith({
      type: "reorder-servers",
      urls: [RELAY_A, RELAY_B, RELAY_C],
    });
  });
});
