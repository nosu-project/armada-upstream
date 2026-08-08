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
      { id: "Brave", name: "Brave", matcher: { "application.name": "Brave" } },
      {
        id: "Sephiria.exe",
        name: "Sephiria.exe",
        matcher: { "application.name": "Sephiria.exe" },
      },
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
      { id: "Browser", name: "Browser", matcher: { "application.name": "Browser" } },
    ]);
    expect(patchBay.list).toHaveBeenCalledOnce();
    expect(patchBay.list).toHaveBeenCalledWith(PLAYBACK_PROPERTIES);
  });

  it("names a source by what it IS, so a re-list cannot rebind the id", () => {
    // The picker hands an id back to start the share, and any second listing in
    // between (a reopened dialog, the voice settings pane) rebuilds the table.
    // A positional id would then point at whichever app now sorts into that
    // slot, and the wrong application's audio goes into the call.
    const listing = (names) => ({
      list: vi.fn(() => names.map((name) => ({
        "node.name": name,
        "application.name": name,
        "media.class": "Stream/Output/Audio",
      }))),
    });

    const before = listLinuxAudioApplications(listing(["Brave", "Music"]), null);
    const after = listLinuxAudioApplications(listing(["Ardour", "Brave", "Music"]), null);

    const idOf = (sources, name) => sources.find((source) => source.name === name)?.id;
    expect(idOf(before, "Music")).toBe(idOf(after, "Music"));
    expect(idOf(before, "Brave")).toBe(idOf(after, "Brave"));
    // And an id for an application that has since gone away resolves to nothing
    // rather than to its neighbour.
    expect(idOf(after, "Ardour")).not.toBe(idOf(before, "Brave"));
  });
});
