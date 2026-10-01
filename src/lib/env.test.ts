// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { config } from "./env";

describe("config", () => {
  afterEach(() => {
    delete window.ENV;
  });

  it("falls back to the build value without window.ENV", () => {
    expect(config("APP_NAME")).toBe(__ARMADA_BUILD_CONFIG__.APP_NAME);
  });

  it("falls back to the build value for a name window.ENV lacks", () => {
    window.ENV = { SOMETHING_ELSE: "x" };
    expect(config("APP_NAME")).toBe(__ARMADA_BUILD_CONFIG__.APP_NAME);
  });

  it("prefers a string in window.ENV", () => {
    window.ENV = { APP_NAME: "Flotilla" };
    expect(config("APP_NAME")).toBe("Flotilla");
  });

  it("honours an empty string, so a host can turn a setting off", () => {
    window.ENV = { CONCORD_AV_SERVERS: "" };
    expect(config("CONCORD_AV_SERVERS")).toBe("");
  });

  it("ignores a value that is not a string", () => {
    window.ENV = { APP_NAME: 42, APP_RELAYS: ["wss://a"] };
    expect(config("APP_NAME")).toBe(__ARMADA_BUILD_CONFIG__.APP_NAME);
    expect(config("APP_RELAYS")).toBe(__ARMADA_BUILD_CONFIG__.APP_RELAYS);
  });

  it("ignores a window.ENV that is not an object", () => {
    (window as { ENV?: unknown }).ENV = "APP_NAME=Flotilla";
    expect(config("APP_NAME")).toBe(__ARMADA_BUILD_CONFIG__.APP_NAME);
  });
});
