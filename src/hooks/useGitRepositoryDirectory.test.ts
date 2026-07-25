import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import { GIT_REPOSITORY_ANNOUNCEMENT_KIND, parseGitRepositoryAnnouncement } from "@/lib/gitActivity";

import { searchGitRepositories } from "./useGitRepositoryDirectory";

const OWNER = "a".repeat(64);

function repo(id: string, name: string, description: string, createdAt: number) {
  const event: NostrEvent = {
    id: "1".repeat(64),
    pubkey: OWNER,
    created_at: createdAt,
    kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
    content: "",
    tags: [["d", id], ["name", name], ["description", description], ["relays", "wss://relay.example/"]],
    sig: "0".repeat(128),
  };
  return parseGitRepositoryAnnouncement(event)!;
}

describe("searchGitRepositories", () => {
  const directory = [
    repo("armada", "Armada", "Encrypted communities", 100),
    repo("armada-site", "Armada Website", "Landing pages", 200),
    repo("flotilla", "Flotilla", "Like armada but smaller", 300),
    repo("unrelated", "Unrelated", "Nothing here", 400),
  ];

  it("ranks exact, then prefix, then substring, then description", () => {
    expect(searchGitRepositories(directory, "armada").map((r) => r.identifier)).toEqual([
      "armada",
      "armada-site",
      "flotilla",
    ]);
  });

  it("shows newest entries for an empty query", () => {
    expect(searchGitRepositories(directory, "", 2).map((r) => r.identifier)).toEqual([
      "unrelated",
      "flotilla",
    ]);
  });

  it("matches case-insensitively and respects the limit", () => {
    expect(searchGitRepositories(directory, "ARMADA", 1).map((r) => r.identifier)).toEqual(["armada"]);
  });
});
