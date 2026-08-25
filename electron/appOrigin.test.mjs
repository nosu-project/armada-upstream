import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isArmadaAppUrl, isExternallyOpenableUrl, internalAppLinkPath } =
  require("./appOrigin.js");

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

  it("treats the app's own URLs as internal despite the null origin", () => {
    // `new URL("app://armada/x").origin` is the string "null" for a custom
    // scheme, so an origin comparison classifies the app's OWN pages as
    // external and hands them to the OS handler for app:.
    expect(isExternallyOpenableUrl("app://armada/c2/community")).toBe(false);
  });
});

describe("opening a link in the system browser", () => {
  it("allows the web schemes a chat message can legitimately carry", () => {
    expect(isExternallyOpenableUrl("https://example.com/a")).toBe(true);
    expect(isExternallyOpenableUrl("http://example.com/a")).toBe(true);
    expect(isExternallyOpenableUrl("mailto:someone@example.com")).toBe(true);
  });

  it("refuses schemes that hand the OS something to execute", () => {
    // window.open reaches this from ANY frame, including the sandboxed
    // WebXDC/embed iframes that run untrusted third-party app code.
    expect(isExternallyOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isExternallyOpenableUrl("smb://attacker.example/share")).toBe(false);
    expect(isExternallyOpenableUrl("ms-msdt:/id")).toBe(false);
    expect(isExternallyOpenableUrl("vscode://file/etc/passwd")).toBe(false);
    expect(isExternallyOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isExternallyOpenableUrl("")).toBe(false);
    expect(isExternallyOpenableUrl("not a URL")).toBe(false);
  });
});

describe("routing our own App Links into the shell", () => {
  const HOST = "armada.buzz";

  it("returns the router path for a link to our own host", () => {
    expect(internalAppLinkPath("https://armada.buzz/c/community/channel/m/abc", HOST))
      .toBe("/c/community/channel/m/abc");
    expect(internalAppLinkPath("https://armada.buzz/dm/npub1x/m/def", HOST))
      .toBe("/dm/npub1x/m/def");
    // Search and hash travel with the path (invite secrets ride the fragment).
    expect(internalAppLinkPath("https://armada.buzz/invite/naddr1?code=1#secret", HOST))
      .toBe("/invite/naddr1?code=1#secret");
  });

  it("matches the host case-insensitively", () => {
    expect(internalAppLinkPath("https://ARMADA.buzz/s/relay/group/m/x", HOST))
      .toBe("/s/relay/group/m/x");
    expect(internalAppLinkPath("https://armada.buzz/s/relay/group", "ARMADA.BUZZ"))
      .toBe("/s/relay/group");
  });

  it("declines a foreign host, a non-https scheme, or a missing host", () => {
    expect(internalAppLinkPath("https://evil.example/c/a/b/m/x", HOST)).toBe(null);
    expect(internalAppLinkPath("http://armada.buzz/c/a/b/m/x", HOST)).toBe(null);
    expect(internalAppLinkPath("app://armada/c/a/b", HOST)).toBe(null);
    expect(internalAppLinkPath("https://armada.buzz/c/a/b", null)).toBe(null);
    expect(internalAppLinkPath("not a URL", HOST)).toBe(null);
  });

  it("declines the bare root and protocol-relative lookalikes", () => {
    // A bare domain open is not a deep link — leave it to ordinary handling.
    expect(internalAppLinkPath("https://armada.buzz/", HOST)).toBe(null);
    expect(internalAppLinkPath("https://armada.buzz", HOST)).toBe(null);
    // `//evil.example` is a protocol-relative URL naming another origin, even
    // when it arrives on our own host's authority.
    expect(internalAppLinkPath("https://armada.buzz//evil.example/x", HOST)).toBe(null);
  });
});
