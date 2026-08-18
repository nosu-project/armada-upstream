import { describe, expect, it } from "vitest";

import { WEBXDC_MIME, WEBXDC_MIMES, isWebxdcMime } from "@/lib/webxdcMime";

/**
 * The MIME is a cross-client contract, not a label. Vector maps only the `vnd`
 * spelling to the `xdc` extension, and decides a file is a Mini App by that
 * extension alone; anything else reaches its disk as `<hash>.x-webxdc` and
 * opens nothing.
 */
describe("the webxdc MIME", () => {
  it("writes what Vector reads", () => {
    expect(WEBXDC_MIME).toBe("application/vnd.webxdc+zip");
  });

  it("still recognizes the MIME Armada used to write", () => {
    // Messages already on relays carry it and must keep launching.
    expect(isWebxdcMime("application/x-webxdc")).toBe(true);
    expect(WEBXDC_MIMES).toContain("application/x-webxdc");
  });

  it("accepts either spelling, cased or padded as a relay may have it", () => {
    expect(isWebxdcMime("APPLICATION/VND.WEBXDC+ZIP")).toBe(true);
    expect(isWebxdcMime("  application/x-webxdc  ")).toBe(true);
  });

  it("refuses everything else, including a plain zip", () => {
    for (const m of ["application/zip", "application/octet-stream", "image/png", "", undefined, null]) {
      expect(isWebxdcMime(m), String(m)).toBe(false);
    }
  });

  it("keeps the written MIME inside the accepted set", () => {
    // The pair is only useful while the thing we write is a thing we read.
    expect(isWebxdcMime(WEBXDC_MIME)).toBe(true);
  });
});
