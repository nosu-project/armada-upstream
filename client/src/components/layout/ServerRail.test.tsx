// Wiring test for the rail's drag-to-reorder/fold gesture: mounts the real
// ServerRail (data hooks mocked), fakes slot geometry (jsdom has no layout),
// and drives the pointer-event flow to assert drops land in the layout.
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultConfig, type AppConfig } from "@/contexts/AppContext";

import { ServerRail } from "./ServerRail";

// ─── Mocks: data hooks (the rail's view data, all inert) ─────────────────

vi.mock("@/components/dialogs/AddDialog", () => ({ AddDialog: () => null }));
vi.mock("@/hooks/useCall", () => ({ useCall: () => ({ activeCall: null }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useDirectMessages", () => ({ useHasUnreadDMs: () => false }));
vi.mock("@/hooks/useMeshTransport", () => ({
  useMeshTransport: () => ({ mesh: { available: false } }),
}));
vi.mock("@/hooks/useRelayGroups", () => ({ useRelayGroups: () => ({ data: [] }) }));
vi.mock("@/hooks/useRelayInfo", () => ({ useRelayInfo: () => ({ data: undefined }) }));
vi.mock("@/hooks/useRelayUnread", () => ({
  useRelayUnread: () => ({ anyUnread: false, anyMention: false }),
}));
vi.mock("@/hooks/useUserGroupList", () => ({
  useUpdateUserGroupList: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/concord-v1/hooks/useConcordList", () => ({
  useConcordList: () => ({ data: undefined }),
  useConcordCommunity: () => undefined,
}));
vi.mock("@/concord-v1/hooks/useConcordMetadata", () => ({
  useConcordMetadata: () => ({ data: undefined }),
}));
vi.mock("@/concord-v1/hooks/useCommunityImageDescriptors", () => ({
  useCommunityImageDescriptors: () => ({ icon: undefined }),
}));
vi.mock("@/concord-v1/hooks/useDecryptedCommunityImage", () => ({
  useDecryptedCommunityImage: () => undefined,
}));
vi.mock("@/concord-v2/hooks/useCommunityList2", () => ({
  useCommunity2: () => undefined,
  useLiveCommunities2: () => [],
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
    PLATFORM_RELAYS: ["wss://a.example/", "wss://b.example/", "wss://c.example/"],
    normalizeRelayUrl: (u: string) => u,
    relayToRouteParam: (u: string) => encodeURIComponent(u),
  };
});

// Mutable config store backing the mocked AppContext.
let config: AppConfig;
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
function mouseDrag(fromAnchor: string, toY: number) {
  const el = document.querySelector(`[data-rail-anchor="${fromAnchor}"]`);
  expect(el, `element with anchor ${fromAnchor}`).toBeTruthy();
  const anchored = Array.from(document.querySelectorAll("[data-rail-anchor]"));
  const startY = slotCenter(anchored.indexOf(el!));
  firePointer(el!, "pointerdown", { x: 36, y: startY });
  // Cross the 6px movement threshold to pick up…
  firePointer(window, "pointermove", { x: 36, y: startY + 8 });
  // …drag to the target…
  firePointer(window, "pointermove", { x: 36, y: toY });
  // …and drop.
  firePointer(window, "pointerup", { x: 36, y: toY });
}

function renderRail() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ServerRail />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("ServerRail drag wiring", () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    config = { ...defaultConfig, railLayout: [], railOrder: [], railOpenFolders: [] };
    restoreGeometry = installGeometry();
    return () => restoreGeometry();
  });

  it("drops one server onto another to create a folder", () => {
    renderRail();
    // Slots (DOM order): 0=A, 1=B, 2=C.
    mouseDrag(`item:${RELAY_A}`, slotCenter(1)); // middle of B → combine
    expect(config.railLayout).toEqual([
      { type: "folder", id: expect.any(String), name: "", keys: [RELAY_B, RELAY_A] },
      { type: "item", key: RELAY_C },
    ]);
  });

  it("drops a server onto a collapsed folder to move it inside", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    renderRail();
    // Slots (DOM order): 0=folder f (collapsed), 1=C.
    mouseDrag(`item:${RELAY_C}`, slotCenter(0)); // middle of the folder → into it
    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B, RELAY_C] },
    ]);
  });

  it("accepts a drop near the folder's edge, not just its center", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    renderRail();
    mouseDrag(`item:${RELAY_C}`, SLOT_TOP + 2); // 2px into the folder's rect
    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B, RELAY_C] },
    ]);
  });

  it("drops between entries to reorder", () => {
    renderRail();
    // Drop A into the gap just above C (below B's center, above C's top).
    mouseDrag(`item:${RELAY_A}`, SLOT_TOP + 2 * PITCH - 6);
    expect(config.railOrder).toEqual([RELAY_B, RELAY_A, RELAY_C]);
  });

  it("drags an item out of an expanded folder to dissolve a 2-item folder", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
      { type: "item", key: RELAY_C },
    ];
    config.railOpenFolders = ["f"];
    renderRail();
    // Slots (DOM order): 0=folder header, 1=A (child), 2=B (child), 3=C.
    mouseDrag(`item:${RELAY_A}`, SLOT_TOP + 4 * PITCH); // below everything → end
    expect(config.railLayout).toEqual([
      { type: "item", key: RELAY_B },
      { type: "item", key: RELAY_C },
      { type: "item", key: RELAY_A },
    ]);
  });
});
