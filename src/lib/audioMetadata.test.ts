import { describe, expect, it } from "vitest";

import { audioTagsFrom } from "./audioMetadata";
import { parseImetaMap } from "./imeta";

describe("audioTagsFrom", () => {
  it("lifts title, artist, album and year", () => {
    expect(audioTagsFrom({
      title: "Intro",
      artist: "Limp Bizkit",
      albumArtist: "Limp Bizkit",
      album: "Significant Other",
      date: new Date("1999-01-01T00:00:00Z"),
    })).toEqual({ title: "Intro", artist: "Limp Bizkit", album: "Significant Other", year: "1999" });
  });

  it("falls back to the album artist only when the track has none", () => {
    expect(audioTagsFrom({ albumArtist: "Various Artists" }).artist).toBe("Various Artists");
    expect(audioTagsFrom({ artist: "Nobody", albumArtist: "Various Artists" }).artist).toBe("Nobody");
  });

  it("flattens each value to one capped line and drops empty ones", () => {
    const tags = audioTagsFrom({ title: "  Two\nLines\u0000 ", artist: "   ", album: "x".repeat(500) });
    expect(tags.title).toBe("Two Lines");
    expect(tags.artist).toBeUndefined();
    expect(tags.album).toHaveLength(200);
  });

  it("ignores an unparseable date", () => {
    expect(audioTagsFrom({ date: new Date("nonsense") }).year).toBeUndefined();
  });
});

describe("parseImetaMap audio tags", () => {
  it("reads a track's title, artist, album, year and cover", () => {
    const entry = parseImetaMap([[
      "imeta",
      "url https://blossom.example/a.mp3",
      "m audio/mpeg",
      "thumb https://blossom.example/cover.jpg",
      "title Intro",
      "artist Limp Bizkit",
      "album Significant Other",
      "year 1999",
    ]]).get("https://blossom.example/a.mp3");
    expect(entry).toMatchObject({
      thumbnail: "https://blossom.example/cover.jpg",
      title: "Intro",
      artist: "Limp Bizkit",
      album: "Significant Other",
      year: "1999",
    });
  });
});
