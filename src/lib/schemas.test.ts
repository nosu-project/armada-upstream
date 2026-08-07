import { describe, expect, it } from "vitest";

import { STOCK_RELAYS } from "@/concord-v2/lib/stockRelays";
import { defaultConfig, SYNCED_CONFIG_KEYS } from "@/contexts/AppContext";
import { AppConfigSchema } from "@/lib/schemas";

describe("AppConfigSchema", () => {
  /**
   * `deserializeConfig` (AppProvider) reads persisted config by walking
   * `AppConfigSchema.shape` — a key absent from the schema is WRITTEN to
   * localStorage and then silently dropped on the next load.
   *
   * A synced key survives that anyway (the encrypted-settings event restores
   * it), so the schema is allowed to omit those. A per-device key has no other
   * restore path: leave it out and the setting simply never persists, with
   * nothing failing to say so. `collapsedChannelCategories` shipped that way
   * once; this is the check that catches the next one.
   */
  it("covers every per-device config key", () => {
    const covered = new Set(Object.keys(AppConfigSchema.shape));
    const synced = new Set<string>(SYNCED_CONFIG_KEYS);
    const perDevice = Object.keys(defaultConfig).filter((key) => !synced.has(key));
    expect(perDevice.filter((key) => !covered.has(key))).toEqual([]);
  });

  it("round-trips collapsed channel categories", () => {
    const collapsed = { abcdef: ["voice", "team"] };
    expect(AppConfigSchema.shape.collapsedChannelCategories.parse(collapsed)).toEqual(collapsed);
    expect(AppConfigSchema.shape.collapsedChannelCategories.parse("nonsense")).toEqual({});
  });

  /**
   * Community relays default to the stock set and are their own key: folding
   * them back into `appRelays` is what put communities on relays their creator
   * never chose. A config predating the key picks the default up for free
   * (`deserializeConfig` starts from `defaultConfig`), so there is no
   * migration to keep in step.
   */
  it("keeps community relays separate from app relays, defaulting to the stock set", () => {
    expect(defaultConfig.communityRelays).toEqual(STOCK_RELAYS);
    expect(defaultConfig.communityRelays).not.toEqual(defaultConfig.appRelays);
    const mine = ["wss://mine.example.com"];
    expect(AppConfigSchema.shape.communityRelays.parse(mine)).toEqual(mine);
    expect(AppConfigSchema.shape.communityRelays.parse("nonsense")).toEqual(STOCK_RELAYS);
  });
});
