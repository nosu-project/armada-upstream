import { describe, expect, it } from "vitest";

import { nativeNotificationConfigAction } from "@/lib/nativeNotificationConfig";

const base = {
  loggedOut: false,
  enablement: "enabled" as const,
  allReady: false,
  nothingToWatch: false,
  persistedConfigEnabled: undefined,
  policyReady: true,
};

describe("nativeNotificationConfigAction", () => {
  it("never disables during unknown startup", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      enablement: "unknown",
      loggedOut: true,
      allReady: true,
      nothingToWatch: true,
      persistedConfigEnabled: false,
    })).toBe("preserve");
  });

  it("still updates DMs and prefs while the group-list source remains offline", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      persistedConfigEnabled: true,
    })).toBe("configure");
  });

  it("does not manufacture an empty config from an incomplete fresh snapshot", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      nothingToWatch: true,
    })).toBe("preserve");
  });

  it("waits for account policy before a fresh bootstrap", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      policyReady: false,
      persistedConfigEnabled: false,
    })).toBe("preserve");
    expect(nativeNotificationConfigAction({
      ...base,
      policyReady: false,
      persistedConfigEnabled: true,
    })).toBe("configure");
  });

  it("bootstraps a useful partial config only when native storage is empty", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      persistedConfigEnabled: false,
    })).toBe("configure");
    expect(nativeNotificationConfigAction({
      ...base,
      persistedConfigEnabled: false,
      nothingToWatch: true,
    })).toBe("preserve");
  });

  it("enriches a partial fresh bootstrap when the remaining planes become ready", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      persistedConfigEnabled: false,
      allReady: false,
    })).toBe("configure");
    expect(nativeNotificationConfigAction({
      ...base,
      persistedConfigEnabled: true,
      allReady: true,
    })).toBe("configure");
  });

  it("replaces or disables only from an authoritative complete view", () => {
    expect(nativeNotificationConfigAction({ ...base, allReady: true })).toBe("configure");
    expect(nativeNotificationConfigAction({
      ...base,
      allReady: true,
      nothingToWatch: true,
    })).toBe("disable");
  });

  it("always clears an explicit disable or logout", () => {
    expect(nativeNotificationConfigAction({
      ...base,
      enablement: "disabled",
      persistedConfigEnabled: true,
    })).toBe("disable");
    expect(nativeNotificationConfigAction({
      ...base,
      loggedOut: true,
      persistedConfigEnabled: true,
    })).toBe("disable");
  });
});
