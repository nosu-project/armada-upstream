import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isArmadaAppUrl, isExternallyOpenableUrl } = require("./appOrigin.js");

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
