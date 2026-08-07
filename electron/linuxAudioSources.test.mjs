import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PLAYBACK_PROPERTIES,
  PROCESS_PROPERTIES,
  listLinuxAudioApplications,
} = require("./linuxAudioSources.js");

describe("Linux application audio sources", () => {
  it("discovers playback apps without requiring optional PipeWire properties", () => {
    const patchBay = {
      list: vi.fn((properties) => {
        if (properties === PROCESS_PROPERTIES) {
          return [
            { "node.name": "Armada", "application.process.id": "42" },
            { "node.name": "Brave", "application.process.id": "99" },
          ];
        }
        if (properties === PLAYBACK_PROPERTIES) {
          return [
            {
              "node.name": "Brave",
              "application.name": "Brave",
              "media.class": "Stream/Output/Audio",
            },
            {
              "node.name": "Sephiria.exe",
              "application.name": "Sephiria.exe",
              "media.class": "Stream/Output/Audio",
            },
            {
              "node.name": "Brave input",
              "application.name": "Brave input",
              "media.class": "Stream/Input/Audio",
            },
            {
              "node.name": "Armada",
              "application.name": "Armada",
              "media.class": "Stream/Output/Audio",
            },
          ];
        }
        throw new Error("Unexpected PipeWire property request");
      }),
    };

    expect(listLinuxAudioApplications(patchBay, "42")).toEqual([
      { name: "Brave", matcher: { "application.name": "Brave" } },
      { name: "Sephiria.exe", matcher: { "application.name": "Sephiria.exe" } },
    ]);
    expect(patchBay.list).toHaveBeenNthCalledWith(1, PROCESS_PROPERTIES);
    expect(patchBay.list).toHaveBeenNthCalledWith(2, PLAYBACK_PROPERTIES);
  });

  it("groups multiple playback streams from the same application", () => {
    const patchBay = {
      list: vi.fn(() => [
        {
          "node.name": "Browser tab 1",
          "application.name": "Browser",
          "media.class": "Stream/Output/Audio",
        },
        {
          "node.name": "Browser tab 2",
          "application.name": "Browser",
          "media.class": "Stream/Output/Audio",
        },
      ]),
    };

    expect(listLinuxAudioApplications(patchBay, null)).toEqual([
      { name: "Browser", matcher: { "application.name": "Browser" } },
    ]);
    expect(patchBay.list).toHaveBeenCalledOnce();
    expect(patchBay.list).toHaveBeenCalledWith(PLAYBACK_PROPERTIES);
  });
});
