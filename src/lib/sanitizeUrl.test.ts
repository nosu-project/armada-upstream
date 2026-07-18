import { describe, expect, it } from "vitest";

import { isLocalNetworkUrl, sanitizeUrl } from "./sanitizeUrl";

describe("sanitizeUrl", () => {
  it("passes http(s) URLs", () => {
    expect(sanitizeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects other schemes and junk", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeUrl("lightning:lnbc1")).toBeUndefined();
    expect(sanitizeUrl("not a url")).toBeUndefined();
    expect(sanitizeUrl(null)).toBeUndefined();
  });
});

describe("isLocalNetworkUrl", () => {
  it("flags loopback / localhost", () => {
    expect(isLocalNetworkUrl("http://localhost:8080/e.gif")).toBe(true);
    expect(isLocalNetworkUrl("http://foo.localhost/e.gif")).toBe(true);
    expect(isLocalNetworkUrl("http://127.0.0.1/x")).toBe(true);
    expect(isLocalNetworkUrl("https://127.1.2.3/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[::1]:3000/x")).toBe(true);
    expect(isLocalNetworkUrl("http://0.0.0.0/x")).toBe(true);
  });

  it("flags private + link-local + mDNS ranges", () => {
    expect(isLocalNetworkUrl("http://10.0.0.5/x")).toBe(true);
    expect(isLocalNetworkUrl("http://192.168.1.5/x")).toBe(true);
    expect(isLocalNetworkUrl("http://172.16.0.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://172.31.255.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://169.254.10.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://myhost.local/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[fe80::1]/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[fd12::1]/x")).toBe(true);
  });

  it("allows public hosts (incl. public IPs outside private ranges)", () => {
    expect(isLocalNetworkUrl("https://blossom.ditto.pub/e.gif")).toBe(false);
    expect(isLocalNetworkUrl("https://8.8.8.8/x")).toBe(false);
    expect(isLocalNetworkUrl("https://172.15.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl("https://172.32.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl("https://11.0.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl(null)).toBe(false);
    expect(isLocalNetworkUrl("garbage")).toBe(false);
  });
});
