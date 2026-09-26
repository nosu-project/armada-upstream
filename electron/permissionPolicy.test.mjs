import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { allowPermissionCheck, allowPermissionRequest } = require("./permissionPolicy.js");
const { isArmadaAppUrl } = require("./appOrigin.js");

const isAppOrigin = isArmadaAppUrl;
const APP = "app://armada/chat";
const YOUTUBE = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
const MINI_APP = "https://0123abcd.iframe.diy/";

const request = (permission, details, topUrl = APP) =>
  allowPermissionRequest({ permission, details, topUrl, isAppOrigin });

const check = (permission, requestingOrigin, details) =>
  allowPermissionCheck({ permission, requestingOrigin, details, isAppOrigin });

describe("Electron permission policy", () => {
  it("grants the app's own frames its permissions", () => {
    expect(request("media", { isMainFrame: true, requestingUrl: APP })).toBe(true);
    expect(request("fullscreen", { isMainFrame: true, requestingUrl: APP })).toBe(true);
    expect(request("geolocation", { isMainFrame: true, requestingUrl: APP })).toBe(false);
    expect(check("media", "app://armada", { isMainFrame: true })).toBe(true);
  });

  it("grants an embed framed by the app fullscreen and clipboard write", () => {
    const sub = { isMainFrame: false, requestingUrl: YOUTUBE };
    expect(request("fullscreen", sub)).toBe(true);
    expect(request("clipboard-sanitized-write", sub)).toBe(true);

    const subCheck = { isMainFrame: false, embeddingOrigin: "app://armada" };
    expect(check("fullscreen", "https://www.youtube-nocookie.com", subCheck)).toBe(true);
    expect(check("clipboard-sanitized-write", "https://www.youtube-nocookie.com", subCheck)).toBe(true);
    expect(check("clipboard-sanitized-write", "https://open.spotify.com", subCheck)).toBe(true);
  });

  it("gives a Mini App fullscreen but never clipboard write", () => {
    const sub = { isMainFrame: false, requestingUrl: MINI_APP };
    expect(request("fullscreen", sub)).toBe(true);
    expect(request("clipboard-sanitized-write", sub)).toBe(false);

    const subCheck = { isMainFrame: false, embeddingOrigin: "app://armada" };
    expect(check("fullscreen", "https://0123abcd.iframe.diy", subCheck)).toBe(true);
    expect(check("clipboard-sanitized-write", "https://0123abcd.iframe.diy", subCheck)).toBe(false);
  });

  it("matches clipboard embed origins exactly", () => {
    const subCheck = { isMainFrame: false, embeddingOrigin: "app://armada" };
    for (const origin of [
      "http://www.youtube-nocookie.com",
      "https://www.youtube-nocookie.com.evil.example",
      "https://evil.example",
      "not a url",
    ]) {
      expect(check("clipboard-sanitized-write", origin, subCheck)).toBe(false);
    }
    expect(
      request("clipboard-sanitized-write", {
        isMainFrame: false,
        requestingUrl: "https://user:pw@www.youtube.com.evil.example/embed/x",
      }),
    ).toBe(false);
  });

  it("never delegates capture, clipboard read or notifications to an embed", () => {
    const sub = { isMainFrame: false, requestingUrl: YOUTUBE };
    for (const permission of ["media", "display-capture", "clipboard-read", "notifications", "pointerLock"]) {
      expect(request(permission, sub)).toBe(false);
      expect(
        check(permission, "https://www.youtube-nocookie.com", {
          isMainFrame: false,
          embeddingOrigin: "app://armada",
        }),
      ).toBe(false);
    }
  });

  it("denies a foreign top-level page, even its own subframes", () => {
    expect(request("fullscreen", { isMainFrame: true, requestingUrl: YOUTUBE }, YOUTUBE)).toBe(false);
    expect(request("fullscreen", { isMainFrame: false, requestingUrl: YOUTUBE }, YOUTUBE)).toBe(false);
    expect(
      check("fullscreen", "https://www.youtube-nocookie.com", {
        isMainFrame: false,
        embeddingOrigin: "https://evil.example",
      }),
    ).toBe(false);
    expect(check("fullscreen", "https://www.youtube-nocookie.com", { isMainFrame: true })).toBe(false);
  });
});
