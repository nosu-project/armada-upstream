import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PACKAGED_APP_REFERRER,
  YOUTUBE_EMBED_FILTER,
  installYouTubeEmbedIdentity,
  isYouTubeEmbedSubFrame,
  requestHeadersWithYouTubeIdentity,
} = require("./youtubeEmbedIdentity.js");

const youtubeRequest = (overrides = {}) => ({
  url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
  resourceType: "subFrame",
  requestHeaders: { Accept: "text/html" },
  ...overrides,
});

describe("packaged Electron YouTube identity", () => {
  it("installs before use only for packaged builds", () => {
    const webRequest = { onBeforeSendHeaders: vi.fn() };

    expect(installYouTubeEmbedIdentity({ webRequest, isPackaged: false })).toBe(false);
    expect(webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();

    expect(installYouTubeEmbedIdentity({ webRequest, isPackaged: true })).toBe(true);
    expect(webRequest.onBeforeSendHeaders).toHaveBeenCalledOnce();
    expect(webRequest.onBeforeSendHeaders.mock.calls[0][0]).toEqual(YOUTUBE_EMBED_FILTER);
  });

  it("adds the desktop app id to a YouTube embed subframe with no referrer", () => {
    expect(requestHeadersWithYouTubeIdentity(youtubeRequest())).toEqual({
      Accept: "text/html",
      Referer: PACKAGED_APP_REFERRER,
    });
  });

  it("recognizes both supported YouTube hosts with and without www", () => {
    for (const host of [
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
      "youtube.com",
      "www.youtube.com",
    ]) {
      expect(
        isYouTubeEmbedSubFrame(youtubeRequest({ url: `https://${host}/embed/video-id` })),
      ).toBe(true);
    }
  });

  it("preserves a real HTTP(S) web referrer regardless of header casing", () => {
    const http = youtubeRequest({
      requestHeaders: { referer: "http://localhost:8080/channel" },
    });
    const https = youtubeRequest({
      requestHeaders: { REFERER: "https://self-hosted.example/chat" },
    });

    expect(requestHeadersWithYouTubeIdentity(http)).toBe(http.requestHeaders);
    expect(requestHeadersWithYouTubeIdentity(https)).toBe(https.requestHeaders);
  });

  it("replaces a custom-scheme or malformed referrer case-insensitively", () => {
    expect(
      requestHeadersWithYouTubeIdentity(
        youtubeRequest({ requestHeaders: { referer: "app://armada/room" } }),
      ),
    ).toEqual({ referer: PACKAGED_APP_REFERRER });
    expect(
      requestHeadersWithYouTubeIdentity(
        youtubeRequest({ requestHeaders: { REFERER: "not a URL", Referer: "" } }),
      ),
    ).toEqual({ REFERER: PACKAGED_APP_REFERRER });
  });

  it("does not attach the identity to any other request", () => {
    const cases = [
      youtubeRequest({ resourceType: "mainFrame" }),
      youtubeRequest({ resourceType: "xhr" }),
      youtubeRequest({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      youtubeRequest({ url: "https://www.youtube.com.evil.example/embed/video-id" }),
      youtubeRequest({ url: "https://music.youtube.com/embed/video-id" }),
      youtubeRequest({ url: "http://www.youtube.com/embed/video-id" }),
      youtubeRequest({ url: "not a URL" }),
    ];

    for (const request of cases) {
      expect(requestHeadersWithYouTubeIdentity(request)).toBe(request.requestHeaders);
    }
  });

  it("passes the narrowly scoped headers through the registered callback", () => {
    let listener;
    const webRequest = {
      onBeforeSendHeaders: (_filter, next) => {
        listener = next;
      },
    };
    installYouTubeEmbedIdentity({ webRequest, isPackaged: true });
    const callback = vi.fn();

    listener(youtubeRequest(), callback);

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "text/html",
        Referer: PACKAGED_APP_REFERRER,
      },
    });
  });
});
