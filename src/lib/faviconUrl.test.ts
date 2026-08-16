import { describe, expect, it } from "vitest";

import { FAVICON_URL_TEMPLATE, faviconUrl, templateUrl } from "@/lib/faviconUrl";
import { fillUriTemplate } from "@/lib/uriTemplate";

describe("fillUriTemplate (the RFC 6570 subset)", () => {
  it("percent-encodes a simple expansion and keeps reserved characters for {+var}", () => {
    expect(fillUriTemplate("https://s.example/{href}", { href: "https://a.example/x?y=1" }))
      .toBe("https://s.example/https%3A%2F%2Fa.example%2Fx%3Fy%3D1");
    expect(fillUriTemplate("https://s.example/{+href}", { href: "https://a.example/x?y=1" }))
      .toBe("https://s.example/https://a.example/x?y=1");
  });

  it("expands an unknown variable to nothing rather than leaving the braces", () => {
    expect(fillUriTemplate("https://s.example/{nope}", {})).toBe("https://s.example/");
  });
});

describe("faviconUrl", () => {
  it("fills the service template with the host, never fetching from the host itself", () => {
    const url = faviconUrl("https://voice.example.com");
    expect(url).toBe("https://ditto.pub/api/favicon/voice.example.com");
    // The point of the template: the request goes to the service, not to the
    // host being rendered.
    expect(new URL(url!).hostname).not.toBe("voice.example.com");
  });

  it("honors a template that opts back into contacting the host", () => {
    expect(faviconUrl("https://voice.example.com", "{+origin}/favicon.ico"))
      .toBe("https://voice.example.com/favicon.ico");
  });

  it("returns undefined for something that isn't a URL, leaving the caller its fallback", () => {
    expect(faviconUrl("voice.example.com")).toBeUndefined();
  });

  it("exposes the URL's parts to a template", () => {
    expect(templateUrl({ template: "{hostname}|{port}|{protocol}", url: "https://a.example:8443/x" }))
      .toBe("a.example|8443|https%3A");
    expect(FAVICON_URL_TEMPLATE).toContain("{hostname}");
  });
});
