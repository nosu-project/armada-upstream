import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearTabAttention,
  installTabAttentionClearHandlers,
  markTabAttention,
} from "./tabAttention";

describe("browser tab attention", () => {
  let visibility: DocumentVisibilityState;
  let focused: boolean;

  beforeEach(() => {
    document.title = "Armada";
    visibility = "hidden";
    focused = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });

  afterEach(() => {
    clearTabAttention();
    vi.restoreAllMocks();
  });

  it("marks an inactive tab only once", () => {
    expect(markTabAttention()).toBe(true);
    expect(markTabAttention()).toBe(true);
    expect(document.title).toBe("● Armada");
  });

  it("does not mark the tab the user is viewing", () => {
    visibility = "visible";
    focused = true;

    expect(markTabAttention()).toBe(false);
    expect(document.title).toBe("Armada");
  });

  it("clears only when the tab is visible and focused", () => {
    const uninstall = installTabAttentionClearHandlers();
    markTabAttention();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("● Armada");

    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(document.title).toBe("Armada");

    uninstall();
  });
});
