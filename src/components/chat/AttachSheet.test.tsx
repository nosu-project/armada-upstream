import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MonitorPlay } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { AttachSheet } from "./AttachSheet";

import type { GalleryItem } from "@/lib/mediaGallery";

const items: GalleryItem[] = [1, 2, 3].map((id) => ({
  id,
  uri: `content://media/${id}`,
  video: false,
  mime: "image/jpeg",
  name: `IMG_${id}.jpg`,
  size: 1,
  modified: 1,
  width: 1,
  height: 1,
  duration: 0,
}));

const thumbnail = vi.hoisted(() => vi.fn((_item: GalleryItem) => Promise.resolve("data:,")));

vi.mock("@/lib/mediaGallery", () => ({
  hasMediaGallery: () => true,
  checkMediaAccess: () => Promise.resolve("full"),
  requestMediaAccess: () => Promise.resolve("full"),
  openMediaSettings: () => Promise.resolve(),
  listRecentMedia: () => Promise.resolve({ items, more: false }),
  galleryThumbnailSrc: thumbnail,
  galleryItemSrc: () => "data:,",
}));

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

describe("AttachSheet with the camera roll", () => {
  it("picks items in tap order and hands them over", async () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AttachSheet open onOpenChange={onOpenChange} actions={[]} onPickGalleryItems={onPick} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Photo IMG_3.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Photo IMG_1.jpg" }));

    fireEvent.click(screen.getByRole("button", { name: "Add 2 items" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).toHaveBeenCalledWith([items[2], items[0]], { spoiler: false });
  });

  it("marks the picks as spoilers from the selection bar", async () => {
    const onPick = vi.fn();
    render(<AttachSheet open onOpenChange={() => {}} actions={[]} onPickGalleryItems={onPick} />);
    fireEvent.click(await screen.findByRole("button", { name: "Photo IMG_2.jpg" }));
    const toggle = screen.getByRole("button", { name: "Mark as spoiler" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 item" }));
    expect(onPick).toHaveBeenCalledWith([items[1]], { spoiler: true });
  });

  // The sheet's Portal renders nothing on its first commit, so a measurement
  // wired from refs at mount never ran and the grid had no footer clearance.
  it("measures the floating footer into --footer-h", async () => {
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(72);
    try {
      render(<AttachSheet open onOpenChange={() => {}} actions={[]} onPickGalleryItems={() => {}} />);
      await screen.findByRole("button", { name: "Photo IMG_1.jpg" });
      const measured = [...document.querySelectorAll<HTMLElement>("div")].find((el) =>
        el.style.getPropertyValue("--footer-h"));
      expect(measured?.style.getPropertyValue("--footer-h")).toBe("72px");
    } finally {
      offsetHeight.mockRestore();
    }
  });

  it("turns to the Apps page and back", async () => {
    render(
      <AttachSheet
        open
        onOpenChange={() => {}}
        actions={[]}
        apps={[{ id: "watch", label: "Watch together", icon: MonitorPlay, onSelect: () => {} }]}
        onPickGalleryItems={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Apps" }));
    expect(screen.getByRole("button", { name: /Watch together/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Watch together/ })).not.toBeInTheDocument());
  });

  it("asks for a tile's thumbnail only once it nears the viewport, and only once", async () => {
    const observers: { callback: IntersectionObserverCallback; init?: IntersectionObserverInit; targets: Set<Element> }[] = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      private readonly entry;
      constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
        this.entry = { callback, init, targets: new Set<Element>() };
        observers.push(this.entry);
      }
      observe(el: Element) { this.entry.targets.add(el); }
      unobserve(el: Element) { this.entry.targets.delete(el); }
      disconnect() { this.entry.targets.clear(); }
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    thumbnail.mockClear();
    try {
      render(<AttachSheet open onOpenChange={() => {}} actions={[]} onPickGalleryItems={() => {}} />);
      const tile = await screen.findByRole("button", { name: "Photo IMG_2.jpg" });
      const io = observers.find((o) => o.targets.has(tile));
      expect(io?.init?.root).toBeInstanceOf(HTMLElement);
      expect(io?.init?.rootMargin).toMatch(/^\d+px 0px$/);
      expect(thumbnail).not.toHaveBeenCalled();

      const near = () => act(async () => {
        io!.callback([{ target: tile, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      await near();
      await waitFor(() => expect(tile.querySelector("img")).not.toBeNull());
      expect(thumbnail).toHaveBeenCalledTimes(1);
      expect(thumbnail.mock.calls[0][0]).toBe(items[1]);
      // Loaded: the tile stops watching and never asks again.
      expect(io!.targets.has(tile)).toBe(false);
      await near();
      expect(thumbnail).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });
});
