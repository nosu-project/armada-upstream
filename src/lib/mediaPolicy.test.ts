import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_PROXY,
  defaultMediaPolicy,
  fillUriTemplate,
  mediaPolicyFromConfig,
  mediaSrc,
  normalizeMediaProxy,
  parseProxyList,
  proxyMediaUrl,
  routeMediaCandidates,
  type MediaPolicy,
} from "./mediaPolicy";

const IMG = "https://henk.example/ip/ip.png";
const PROXIED_IMG = `https://proxy.shakespeare.diy/?url=${encodeURIComponent(IMG)}`;

function policy(over: Partial<MediaPolicy> = {}): MediaPolicy {
  return { proxy: DEFAULT_MEDIA_PROXY, ...over };
}

describe("fillUriTemplate", () => {
  it("percent-encodes a simple expansion and keeps reserved characters for {+var}", () => {
    expect(fillUriTemplate("https://p.example/?url={href}", { href: "https://a.example/x?y=1&z=2" })).toBe(
      "https://p.example/?url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2",
    );
    expect(fillUriTemplate("https://p.example/{+href}", { href: "https://a.example/x?y=1" })).toBe(
      "https://p.example/https://a.example/x?y=1",
    );
  });

  it("expands an unknown variable to nothing", () => {
    expect(fillUriTemplate("https://p.example/?u={nope}", {})).toBe("https://p.example/?u=");
  });
});

describe("normalizeMediaProxy", () => {
  it("keeps a template that already carries {href}", () => {
    expect(normalizeMediaProxy(` ${DEFAULT_MEDIA_PROXY} `)).toBe(DEFAULT_MEDIA_PROXY);
    expect(normalizeMediaProxy("https://p.example/{+href}")).toBe("https://p.example/{+href}");
  });

  it("appends the encoded {href} to a bare prefix ending in a query param", () => {
    expect(normalizeMediaProxy("https://p.example/?url=")).toBe("https://p.example/?url={href}");
  });

  it("appends the raw {+href} to a bare `?` or path prefix, as corsfix-style proxies want", () => {
    expect(normalizeMediaProxy("https://proxy.corsfix.com/?")).toBe("https://proxy.corsfix.com/?{+href}");
    expect(normalizeMediaProxy("https://cors.example/")).toBe("https://cors.example/{+href}");
  });

  it("reads empty, non-http and unparseable values as no proxy", () => {
    expect(normalizeMediaProxy("")).toBe("");
    expect(normalizeMediaProxy(undefined)).toBe("");
    expect(normalizeMediaProxy("javascript:alert(1)//{href}")).toBe("");
    expect(normalizeMediaProxy("not a url")).toBe("");
  });
});

describe("proxyMediaUrl", () => {
  it("wraps an http(s) URL in the template", () => {
    expect(proxyMediaUrl(IMG, DEFAULT_MEDIA_PROXY)).toBe(PROXIED_IMG);
  });

  it("leaves inline sources, non-http schemes, and already-proxied URLs alone", () => {
    expect(proxyMediaUrl("blob:https://armada.buzz/abc", DEFAULT_MEDIA_PROXY)).toBe("blob:https://armada.buzz/abc");
    expect(proxyMediaUrl("data:image/png;base64,AAAA", DEFAULT_MEDIA_PROXY)).toBe("data:image/png;base64,AAAA");
    expect(proxyMediaUrl(PROXIED_IMG, DEFAULT_MEDIA_PROXY)).toBe(PROXIED_IMG);
    expect(proxyMediaUrl(IMG, "")).toBe(IMG);
  });
});

describe("mediaSrc", () => {
  it("proxies a host when a proxy is set", () => {
    expect(mediaSrc(IMG, policy())).toBe(PROXIED_IMG);
  });

  it("loads directly when no proxy is set", () => {
    expect(mediaSrc(IMG, policy({ proxy: "" }))).toBe(IMG);
  });

  it("never proxies or loads a local-network address", () => {
    expect(mediaSrc("http://192.168.1.1/x.png", policy())).toBeUndefined();
    expect(mediaSrc("http://localhost:8080/x.png", policy({ proxy: "" }))).toBeUndefined();
  });

  it("passes blob and data sources through untouched", () => {
    expect(mediaSrc("blob:https://armada.buzz/abc", policy())).toBe("blob:https://armada.buzz/abc");
    expect(mediaSrc("data:image/png;base64,AAAA", policy())).toBe("data:image/png;base64,AAAA");
  });

  it("is undefined for no URL", () => {
    expect(mediaSrc(undefined, policy())).toBeUndefined();
  });
});

describe("routeMediaCandidates", () => {
  it("proxies every candidate when a proxy is set", () => {
    const out = routeMediaCandidates([IMG, "https://blossom.ditto.pub/abc.png"], policy());
    expect(out.sources).toEqual([
      PROXIED_IMG,
      `https://proxy.shakespeare.diy/?url=${encodeURIComponent("https://blossom.ditto.pub/abc.png")}`,
    ]);
  });

  it("loads every candidate directly with no proxy", () => {
    const out = routeMediaCandidates([IMG, "https://blossom.ditto.pub/abc.png"], policy({ proxy: "" }));
    expect(out.sources).toEqual([IMG, "https://blossom.ditto.pub/abc.png"]);
  });

  it("drops a local-network candidate rather than stopping the walk", () => {
    const out = routeMediaCandidates(
      ["https://blossom.ditto.pub/abc.png", "http://10.0.0.5/abc.png", "https://blossom.primal.net/abc.png"],
      policy({ proxy: "" }),
    );
    expect(out.sources).toEqual(["https://blossom.ditto.pub/abc.png", "https://blossom.primal.net/abc.png"]);
  });

  it("is empty for an empty list", () => {
    expect(routeMediaCandidates([], policy())).toEqual({ sources: [] });
  });
});

describe("routeMediaCandidates with a rotation pool", () => {
  const P1 = "https://p1.example/?url={href}";
  const P2 = "https://p2.example/?url={href}";
  const via = (p: string, u: string) => fillUriTemplate(p, { href: u });

  it("expands each candidate across the pool as ordered fallbacks", () => {
    const { sources } = routeMediaCandidates([IMG], policy({ proxies: [P1, P2] }));
    expect(sources).toHaveLength(2);
    expect(sources).toEqual(expect.arrayContaining([via(P1, IMG), via(P2, IMG)]));
  });

  it("keeps the rotation deterministic for the same URL", () => {
    const a = routeMediaCandidates([IMG], policy({ proxies: [P1, P2] })).sources;
    const b = routeMediaCandidates([IMG], policy({ proxies: [P1, P2] })).sources;
    expect(a).toEqual(b);
  });

  it("does not double-wrap a URL already on a pool host", () => {
    const already = via(P1, IMG);
    expect(routeMediaCandidates([already], policy({ proxies: [P1, P2] })).sources).toEqual([already]);
  });

  it("prefers the pool over the primary and drops local-network candidates", () => {
    const { sources } = routeMediaCandidates(
      [IMG, "http://10.0.0.5/x.png"],
      policy({ proxy: DEFAULT_MEDIA_PROXY, proxies: [P1, P2] }),
    );
    expect(sources).toEqual(expect.arrayContaining([via(P1, IMG), via(P2, IMG)]));
    expect(sources).toHaveLength(2);
  });
});

describe("parseProxyList", () => {
  it("splits lines and commas, drops blanks and comments, normalizes and dedupes", () => {
    const text = [
      "# my proxies",
      "https://p1.example/?url=",
      "  https://p2.example/? ",
      "https://p1.example/?url=",
      "not a url",
      "",
    ].join("\n");
    expect(parseProxyList(text)).toEqual([
      "https://p1.example/?url={href}",
      "https://p2.example/?{+href}",
    ]);
  });

  it("caps a hostile list at MAX_PROXY_POOL", () => {
    const many = Array.from({ length: 100 }, (_, i) => `https://p${i}.example/?url=`).join(",");
    expect(parseProxyList(many)).toHaveLength(32);
  });
});

describe("mediaPolicyFromConfig", () => {
  it("defaults to the public proxy for a missing config", () => {
    expect(mediaPolicyFromConfig(undefined)).toEqual(defaultMediaPolicy());
    expect(defaultMediaPolicy().proxy).toBe(DEFAULT_MEDIA_PROXY);
  });

  it("normalizes and preserves an explicit proxy, including an empty one", () => {
    expect(mediaPolicyFromConfig({ proxy: "https://p.example/?url=" })).toEqual({
      proxy: "https://p.example/?url={href}",
    });
    expect(mediaPolicyFromConfig({ proxy: "" })).toEqual({ proxy: "" });
  });
});
