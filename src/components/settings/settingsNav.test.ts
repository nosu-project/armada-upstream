import { describe, expect, it } from "vitest";

import { resolveSettingsSection } from "./settingsNav";

describe("resolveSettingsSection", () => {
  it("opens a page by its own id", () => {
    expect(resolveSettingsSection("profile")).toEqual({ stack: ["profile"], anchor: undefined });
  });

  it("opens a nested page under its parent", () => {
    expect(resolveSettingsSection("muted-words")).toEqual({ stack: ["privacy", "muted-words"], anchor: undefined });
    expect(resolveSettingsSection("muted")).toEqual({ stack: ["privacy", "blocked"], anchor: "muted" });
  });

  it("opens the page holding a group and anchors on it", () => {
    expect(resolveSettingsSection("discover")).toEqual({ stack: ["privacy"], anchor: "discover" });
    expect(resolveSettingsSection("keys")).toEqual({ stack: ["account"], anchor: "keys" });
    expect(resolveSettingsSection("uploads")).toEqual({ stack: ["relays"], anchor: "uploads" });
  });

  it("falls back to the root list", () => {
    expect(resolveSettingsSection("")).toBeNull();
    expect(resolveSettingsSection("nope")).toBeNull();
  });
});
