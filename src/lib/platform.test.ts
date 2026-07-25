import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `LINK_PREVIEW_ENDPOINT` is read from the environment at module load, so each
 * case stubs the env and re-imports the module rather than calling a setter.
 */
async function loadLinkPreviewUrl(endpoint?: string) {
  if (endpoint === undefined) {
    vi.unstubAllEnvs();
  } else {
    vi.stubEnv("VITE_LINK_PREVIEW_ENDPOINT", endpoint);
  }
  vi.resetModules();
  const { linkPreviewUrl } = await import("./platform");
  return linkPreviewUrl;
}

describe("linkPreviewUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to the public proxy when unconfigured", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl();
    expect(linkPreviewUrl("https://example.com/a")).toBe(
      "https://ditto.pub/api/link-preview/https%3A%2F%2Fexample.com%2Fa",
    );
  });

  it("substitutes the encoded URL for the {url} placeholder", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("https://unfurl.test/api/{url}/preview");
    expect(linkPreviewUrl("https://example.com/a?b=c")).toBe(
      "https://unfurl.test/api/https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc/preview",
    );
  });

  it("appends the encoded URL when there is no placeholder", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("https://unfurl.test/oembed?url=");
    expect(linkPreviewUrl("https://example.com/a")).toBe(
      "https://unfurl.test/oembed?url=https%3A%2F%2Fexample.com%2Fa",
    );
  });

  it("returns null when set empty, disabling generic previews", async () => {
    const linkPreviewUrl = await loadLinkPreviewUrl("   ");
    expect(linkPreviewUrl("https://example.com/a")).toBeNull();
  });
});
