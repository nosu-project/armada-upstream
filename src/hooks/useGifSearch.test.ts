import { describe, expect, it } from "vitest";

import { mapKlipyResults } from "@/hooks/useGifSearch";

describe("mapKlipyResults", () => {
  it("maps KLIPY GIF renditions and uses lightweight MP4 previews", () => {
    const results = mapKlipyResults({
      result: true,
      data: {
        data: [
          {
            id: 42,
            slug: "celebration-42",
            title: "Celebration",
            type: "gif",
            file: {
              hd: {
                gif: { url: "https://media.klipy.com/hd.gif", width: 960, height: 540 },
              },
              sm: {
                mp4: { url: "https://media.klipy.com/sm.mp4", width: 320, height: 180 },
              },
              xs: {
                mp4: { url: "https://media.klipy.com/xs.mp4", width: 160, height: 90 },
              },
            },
          },
        ],
      },
    });

    expect(results).toEqual([
      {
        id: "celebration-42",
        title: "Celebration",
        url: "https://media.klipy.com/hd.gif",
        width: 960,
        height: 540,
        previewSources: [
          { src: "https://media.klipy.com/xs.mp4", type: "video/mp4" },
          { src: "https://media.klipy.com/sm.mp4", type: "video/mp4" },
        ],
      },
    ]);
  });

  it("filters ads and malformed entries while accepting the flat legacy payload", () => {
    const results = mapKlipyResults({
      data: [
        { slug: "ad", type: "ad", file: { hd: { gif: { url: "https://ad" } } } },
        { slug: "missing-file", type: "gif" },
        {
          id: "fallback-id",
          type: "gif",
          file: { md: { gif: { url: "https://media.klipy.com/md.gif" } } },
        },
      ],
    });

    expect(results).toEqual([
      {
        id: "fallback-id",
        title: "",
        url: "https://media.klipy.com/md.gif",
        previewSources: undefined,
        width: 220,
        height: 160,
      },
    ]);
  });
});
