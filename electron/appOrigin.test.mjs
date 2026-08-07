import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isArmadaAppUrl } = require("./appOrigin.js");

describe("packaged Electron origin", () => {
  it("admits permission requests from app://armada", () => {
    expect(isArmadaAppUrl("app://armada")).toBe(true);
    expect(isArmadaAppUrl("app://armada/")).toBe(true);
    expect(isArmadaAppUrl("app://armada/c2/community/channel?message=1")).toBe(true);
  });

  it("rejects other schemes and lookalike authorities", () => {
    expect(isArmadaAppUrl("https://armada")).toBe(false);
    expect(isArmadaAppUrl("app://armada.example/")).toBe(false);
    expect(isArmadaAppUrl("app://armada@evil.example/")).toBe(false);
    expect(isArmadaAppUrl("app://evil@armada/")).toBe(false);
    expect(isArmadaAppUrl("not a URL")).toBe(false);
  });
});
