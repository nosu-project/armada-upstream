import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NRelay } from "@nostrify/types";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bundleNaddr } from "@/concord/lib/invite";

vi.mock("./draw", () => ({
  drawProfile: vi.fn(async () => null),
  drawInvite: vi.fn(async () => null),
}));

const { default: script } = await import("./preview");
const { drawProfile } = await import("./draw");

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const npub = nip19.npubEncode(pubkey);
const profile = finalizeEvent({
  kind: 0,
  created_at: 1_700_000_000,
  tags: [],
  content: JSON.stringify({
    name: "Ana <b>",
    about: "Sails\nfar.\n\n<script>x</script>",
    picture: "https://example.com/a.png",
    website: "javascript:alert(1)",
    shape: "⭐",
  }),
}, sk);

function relay(events: NostrEvent[]): NRelay {
  return {
    query: async (filters: NostrFilter[]) =>
      events.filter((e) => filters.some((f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)))),
  } as unknown as NRelay;
}

const run = (path: string, events: NostrEvent[] = [profile]) =>
  script.preview(new Request(`https://armada.buzz${path}`), { nostr: relay(events), signal: new AbortController().signal });

// Not in TypeScript's DOM lib yet; Node has it.
declare const URLPattern: new (init: { pathname: string }) => { test(input: { pathname: string }): boolean };

const routed = (path: string) => script.routes.some((route) => new URLPattern({ pathname: route }).test({ pathname: path }));

afterEach(() => vi.unstubAllGlobals());

describe("routes", () => {
  it("names profiles and invites", () => {
    for (const path of [
      `/${npub}`,
      `/${npub}/`,
      `/${nip19.nprofileEncode({ pubkey, relays: ["wss://relay.example"] })}`,
      "/alex@gleasonator.com",
      "/@alex@gleasonator.com",
      "/alex%40gleasonator.com",
      "/soapbox.pub",
      `/invite/${bundleNaddr(pubkey)}`,
    ]) expect(routed(path), path).toBe(true);
  });

  it("leaves the rest of the app alone", () => {
    for (const path of ["/", "/settings", "/dm", `/${npub}/x`, "/c/abc", "/invite/relay.example", `/nsec1${npub.slice(5)}`]) {
      expect(routed(path), path).toBe(false);
    }
  });
});

describe("profile", () => {
  it("previews an npub, escaping what its author wrote", async () => {
    const preview = await run(`/${npub}`);
    expect(preview?.title).toBe("Ana <b> on Armada");
    expect(preview?.description).toBe("Sails far. <script>x</script>");
    expect(preview?.body).toContain("<h1>Ana &lt;b&gt;</h1>");
    expect(preview?.body).toContain("<p>Sails<br>\nfar.</p>");
    expect(preview?.body).not.toContain("<script>");
    expect(preview?.body).not.toContain("javascript:");
    expect(preview?.twitter).toBe("summary_large_image");
    expect(drawProfile).toHaveBeenCalledWith("https://example.com/a.png", "⭐", "Ana <b>");
  });

  it("resolves a bare domain as its root NIP-05 user", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json({ names: { _: pubkey } }));
    vi.stubGlobal("fetch", fetch);
    const preview = await run("/soapbox.pub");
    expect(fetch.mock.calls[0][0]).toBe("https://soapbox.pub/.well-known/nostr.json?name=_");
    expect(preview?.title).toBe("Ana <b> on Armada");
  });

  it("refuses a NIP-05 answer that isn't a pubkey", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ names: { ana: "npub1nope" } })));
    expect(await run("/ana@example.com")).toBeNull();
  });

  it("is null for someone with no profile", async () => {
    expect(await run(`/${npub}`, [])).toBeNull();
  });
});

describe("invite", () => {
  it("previews a Concord invite without knowing its community", async () => {
    const preview = await run(`/invite/${bundleNaddr(pubkey)}`);
    expect(preview?.title).toBe("You're invited to a community on Armada");
    expect(preview?.twitter).toBe("summary_large_image");
  });

  it("is null for an naddr that isn't an invite bundle", async () => {
    const naddr = nip19.naddrEncode({ kind: 30023, pubkey, identifier: "x" });
    expect(await run(`/invite/${naddr}`)).toBeNull();
  });
});
