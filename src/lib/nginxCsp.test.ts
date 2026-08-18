import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const nginx = readFileSync(resolve(process.cwd(), "nginx.conf"), "utf8");
const index = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const capacitorConfig = readFileSync(resolve(process.cwd(), "capacitor.config.ts"), "utf8");
const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];

function sourcesFor(name: string): string[] {
  const directive = csp?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return directive?.split(/\s+/).slice(1) ?? [];
}

describe("the self-hosted nginx Content Security Policy", () => {
  it("loads the YouTube API without permitting arbitrary third-party scripts", () => {
    expect(csp).toBeDefined();
    expect(sourcesFor("script-src")).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      "https://www.youtube.com",
    ]);
  });

  it("admits every iframe provider used by the client", () => {
    expect(sourcesFor("frame-src")).toEqual([
      "'self'",
      "https://www.youtube-nocookie.com",
      "https://open.spotify.com",
      "https://*.iframe.diy",
    ]);
  });

  it("makes browsers send their own origin as the YouTube referrer", () => {
    expect(nginx).toContain('add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
    expect(index).toContain('<meta name="referrer" content="strict-origin-when-cross-origin" />');
  });

  it("keeps Android on an HTTPS document origin that can emit that referrer", () => {
    expect(capacitorConfig).toContain("androidScheme: 'https'");
  });
});
