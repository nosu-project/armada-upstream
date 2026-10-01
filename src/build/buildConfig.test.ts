import { describe, expect, it, vi } from "vitest";

import { resolveBuildConfig } from "./buildConfig";

describe("resolveBuildConfig", () => {
  it("reads only the listed names", () => {
    expect(resolveBuildConfig({ APP_NAME: "Flotilla", HOME: "/root", VITE_OTHER: "x" })).toEqual({
      APP_NAME: "Flotilla",
    });
  });

  it("keeps an empty value distinct from an unset one", () => {
    const config = resolveBuildConfig({ CONCORD_AV_SERVERS: "" });
    expect(config.CONCORD_AV_SERVERS).toBe("");
    expect("APP_NAME" in config).toBe(false);
  });

  it("falls back to the VITE_ spelling, with a warning", () => {
    const warn = vi.fn();
    expect(resolveBuildConfig({ VITE_APP_RELAYS: "wss://a" }, warn)).toEqual({ APP_RELAYS: "wss://a" });
    expect(warn).toHaveBeenCalledWith("VITE_APP_RELAYS is deprecated; set APP_RELAYS instead.");
  });

  it("prefers the bare name over the VITE_ spelling, without a warning", () => {
    const warn = vi.fn();
    expect(resolveBuildConfig({ APP_RELAYS: "wss://new", VITE_APP_RELAYS: "wss://old" }, warn)).toEqual({
      APP_RELAYS: "wss://new",
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
