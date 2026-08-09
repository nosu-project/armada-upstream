import { describe, expect, it } from "vitest";

import { defaultConfig, MAX_STARTED_DMS, SYNCED_CONFIG_KEYS } from "@/contexts/AppContext";
import { AppConfigSchema, DmsDocSchema } from "@/lib/schemas";

describe("startedDms config", () => {
  it("starts empty", () => {
    expect(defaultConfig.startedDms).toEqual([]);
  });

  it("round-trips through local persistence and the synced settings payload", () => {
    expect(SYNCED_CONFIG_KEYS).toContain("startedDms");
    expect(AppConfigSchema.shape.startedDms.parse(["peer"])).toEqual(["peer"]);
    expect(DmsDocSchema.parse({ startedDms: ["peer"] }).startedDms).toEqual(["peer"]);
  });

  it("keeps a corrupt value from wiping the rest of the config", () => {
    expect(AppConfigSchema.shape.startedDms.parse("nonsense")).toEqual([]);
  });

  it("bounds the seeded rows", () => {
    expect(MAX_STARTED_DMS).toBeGreaterThan(0);
  });
});
