import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  parseGitTicket,
} from "@/lib/gitActivity";
import {
  gitworkshopRelaySegment,
  gitworkshopRepositoryPath,
  gitworkshopTicketUrl,
} from "@/lib/gitworkshopUrl";
import { routeParamToRelay } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const TICKET_ID = "c".repeat(64);

function ticket(kind: typeof GIT_ISSUE_KIND | typeof GIT_PULL_REQUEST_KIND) {
  return parseGitTicket({
    id: TICKET_ID,
    pubkey: AUTHOR,
    created_at: 1,
    kind,
    content: "",
    tags: [
      ["a", `30617:${OWNER}:armada`, "wss://gleasonator.dev/relay"],
      ["subject", "Relay paths"],
    ],
  } satisfies NostrRumor)!;
}

describe("GitWorkshop repository routes", () => {
  it("keeps a path-bearing relay hint in exactly one segment and round-trips it", () => {
    const path = gitworkshopRepositoryPath(
      "soapbox.pub",
      "armada",
      "wss://gleasonator.dev/relay",
    );

    expect(path).toBe("/soapbox.pub/gleasonator.dev%2Frelay/armada/");

    const [, identity, relaySegment, repositorySegment] = path.split("/");
    expect(identity).toBe("soapbox.pub");
    expect(routeParamToRelay(relaySegment)).toBe("wss://gleasonator.dev/relay");
    expect(decodeURIComponent(repositorySegment)).toBe("armada");
  });

  it("keeps host-only wss relays readable and preserves ws relay schemes", () => {
    expect(gitworkshopRelaySegment("wss://relay.damus.io")).toBe("relay.damus.io");
    expect(gitworkshopRelaySegment("wss://relay.example:7447/nostr?scope=git")).toBe(
      "relay.example%3A7447%2Fnostr%3Fscope%3Dgit",
    );
    const wsSegment = gitworkshopRelaySegment("ws://localhost:7777/nostr?x=1")!;
    expect(wsSegment).toBe("ws%3Alocalhost%3A7777%2Fnostr%3Fx%3D1");
    expect(routeParamToRelay(wsSegment)).toBe("ws://localhost:7777/nostr?x=1");
  });

  it("encodes the repository d-tag independently from the relay segment", () => {
    expect(gitworkshopRepositoryPath(
      "soapbox.pub",
      "team/armada",
      "wss://gleasonator.dev/relay",
    )).toBe("/soapbox.pub/gleasonator.dev%2Frelay/team%2Farmada/");
  });

  it.each([
    [GIT_ISSUE_KIND, "issues"],
    [GIT_PULL_REQUEST_KIND, "prs"],
  ] as const)("uses the shared repository route for kind %s links", (kind, collection) => {
    const parsed = ticket(kind);
    const nevent = nip19.neventEncode({
      id: parsed.id,
      author: parsed.author,
      kind: parsed.kind,
    });

    expect(gitworkshopTicketUrl(parsed)).toBe(
      `https://gitworkshop.dev/${nip19.npubEncode(OWNER)}/gleasonator.dev%2Frelay/armada/${collection}/${nevent}`,
    );
  });
});
