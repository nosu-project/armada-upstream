import { describe, expect, it, vi } from "vitest";

import {
  applySnapshotToVideo,
  classifyWatchLink,
  directVideoTitle,
  EMPTY_SNAPSHOT,
  isSnapshot,
  queueItemPlayer,
  snapshotRate,
  targetPlaybackTime,
  videoMatchesSnapshot,
  type SyncableVideo,
  type WatchSnapshot,
} from "@/lib/watchalong";

const HASH = "a".repeat(64);

describe("classifyWatchLink", () => {
  it("keeps YouTube links on the YouTube path", () => {
    expect(classifyWatchLink("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "youtube",
      videoId: "dQw4w9WgXcQ",
      playlistId: undefined,
    });
    expect(classifyWatchLink("https://www.youtube.com/playlist?list=PLabcdefghij")).toMatchObject({
      kind: "youtube",
      playlistId: "PLabcdefghij",
    });
    expect(classifyWatchLink("dQw4w9WgXcQ")).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
  });

  it("accepts direct video files by extension, with a query string", () => {
    for (const url of [
      "https://example.com/a.mp4",
      "https://example.com/dir/b.WEBM",
      "http://example.com/c.mov?token=1",
      "https://example.com/d.m4v",
      "https://example.com/e.ogv#t=3",
      "https://example.com/f.mkv",
    ]) {
      expect(classifyWatchLink(`  ${url}  `)).toEqual({ kind: "video", url: new URL(url).href });
    }
  });

  it("accepts a Blossom blob, with or without an extension", () => {
    expect(classifyWatchLink(`https://blossom.example/${HASH}`).kind).toBe("video");
    expect(classifyWatchLink(`https://blossom.example/${HASH}.mp4`).kind).toBe("video");
  });

  it("refuses HLS, since no HLS player ships", () => {
    const r = classifyWatchLink("https://example.com/live/index.m3u8");
    expect(r.kind).toBe("invalid");
    expect(r.kind === "invalid" && r.reason).toMatch(/m3u8/);
  });

  it("refuses pages, images, other schemes and local-network hosts", () => {
    for (const input of [
      "https://vimeo.com/123456",
      "https://example.com/pic.png",
      "https://example.com/clip.avi",
      "javascript:alert(1)//a.mp4",
      "data:video/mp4;base64,AAAA",
      "ftp://example.com/a.mp4",
      "http://localhost/a.mp4",
      "http://192.168.1.10/a.mp4",
      "not a link",
      "",
    ]) {
      expect(classifyWatchLink(input).kind, input).toBe("invalid");
    }
  });
});

describe("queueItemPlayer", () => {
  it("chooses YouTube for an id and <video> for a direct url", () => {
    expect(queueItemPlayer({ id: "1", videoId: "dQw4w9WgXcQ" })).toBe("youtube");
    expect(queueItemPlayer({ id: "1", playlistId: "PLabcdefghij" })).toBe("youtube");
    expect(queueItemPlayer({ id: "1", url: "https://example.com/a.mp4" })).toBe("video");
  });

  it("prefers YouTube when both are present, as a YouTube-only build would", () => {
    expect(queueItemPlayer({ id: "1", videoId: "dQw4w9WgXcQ", url: "https://example.com/a.mp4" })).toBe("youtube");
  });

  it("re-validates a peer-sent url and has no player for an unknown entry", () => {
    expect(queueItemPlayer({ id: "1", url: "javascript:alert(1)" })).toBeNull();
    expect(queueItemPlayer({ id: "1", url: "http://127.0.0.1/a.mp4" })).toBeNull();
    expect(queueItemPlayer({ id: "1", url: 42 as unknown as string })).toBeNull();
    expect(queueItemPlayer({ id: "1" })).toBeNull();
    expect(queueItemPlayer(undefined)).toBeNull();
  });
});

describe("snapshot helpers", () => {
  it("reads an older snapshot (no rate) as speed 1", () => {
    const old: WatchSnapshot = { queue: [{ id: "x", videoId: "dQw4w9WgXcQ" }], current: 0, playing: true, time: 5, rev: 3, at: 0 };
    expect(isSnapshot(old)).toBe(true);
    expect(snapshotRate(old)).toBe(1);
    expect(snapshotRate({ rate: 2 })).toBe(2);
    expect(snapshotRate({ rate: 100 })).toBe(1);
    expect(snapshotRate({ rate: Number.NaN })).toBe(1);
    expect(isSnapshot({ queue: "nope" })).toBe(false);
    expect(isSnapshot({ ...old, time: Infinity })).toBe(false);
    expect(isSnapshot({ ...old, rev: Infinity })).toBe(false);
    expect(isSnapshot({ ...old, at: Number.NaN })).toBe(false);
    expect(isSnapshot({ ...old, rate: -Infinity })).toBe(false);
    expect(isSnapshot({ ...old, current: 0.5 })).toBe(false);
    expect(isSnapshot({ ...old, queue: [null] })).toBe(false);
  });

  it("extrapolates the position while playing, scaled by rate", () => {
    const s: WatchSnapshot = { ...EMPTY_SNAPSHOT, playing: true, time: 10, at: 1_000 };
    expect(targetPlaybackTime(s, 3_000)).toBe(12);
    expect(targetPlaybackTime(s, 3_000, 2)).toBe(14);
    expect(targetPlaybackTime({ ...s, playing: false }, 3_000)).toBe(10);
    expect(targetPlaybackTime(s, 0)).toBe(10);
  });

  it("titles a direct entry by file name, else host", () => {
    expect(directVideoTitle("https://example.com/films/My%20Clip.mp4")).toBe("My Clip.mp4");
    expect(directVideoTitle(`https://blossom.example/${HASH}`)).toBe("blossom.example");
  });
});

function mockVideo(init: Partial<{ currentTime: number; paused: boolean; playbackRate: number }> = {}) {
  const video = {
    currentTime: init.currentTime ?? 0,
    paused: init.paused ?? true,
    playbackRate: init.playbackRate ?? 1,
    play: vi.fn(() => {
      video.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
  };
  return video as typeof video & SyncableVideo;
}

describe("applySnapshotToVideo", () => {
  const playing: WatchSnapshot = { ...EMPTY_SNAPSHOT, playing: true, time: 30, at: 10_000, rev: 1 };

  it("seeks to the extrapolated position and plays", async () => {
    const video = mockVideo();
    const p = applySnapshotToVideo(video, playing, 12_000);
    expect(video.currentTime).toBe(32);
    expect(video.play).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBeUndefined();
  });

  it("leaves a position within tolerance alone and doesn't re-play", () => {
    const video = mockVideo({ currentTime: 31, paused: false });
    expect(applySnapshotToVideo(video, playing, 12_000)).toBeUndefined();
    expect(video.currentTime).toBe(31);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("pauses at the committed time without extrapolating", () => {
    const video = mockVideo({ currentTime: 50, paused: false });
    applySnapshotToVideo(video, { ...playing, playing: false }, 99_000);
    expect(video.currentTime).toBe(30);
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("applies the shared speed, and extrapolates with it", () => {
    const video = mockVideo();
    applySnapshotToVideo(video, { ...playing, rate: 1.5 }, 12_000);
    expect(video.playbackRate).toBe(1.5);
    expect(video.currentTime).toBe(33);
  });

  it("hands back an autoplay refusal for the caller to surface", async () => {
    const video = mockVideo();
    const refusal = new DOMException("gesture needed", "NotAllowedError");
    video.play.mockImplementationOnce(() => Promise.reject(refusal));
    await expect(applySnapshotToVideo(video, playing, 10_000)).rejects.toBe(refusal);
  });

  it("recognises an element already showing the snapshot as an echo", () => {
    const video = mockVideo();
    applySnapshotToVideo(video, playing, 12_000);
    expect(videoMatchesSnapshot(video, playing, 12_500)).toBe(true);
    video.pause();
    expect(videoMatchesSnapshot(video, playing, 12_500)).toBe(false);
  });
});
