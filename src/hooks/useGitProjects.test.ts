import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_APPLIED_KIND,
  GIT_STATUS_CLOSED_KIND,
  NIP22_COMMENT_KIND,
  parseGitRepositoryAddress,
  type GitRepositoryAttachment,
} from "@/lib/gitActivity";

import { assembleGitProjects, gitProjectSources } from "./useGitProjects";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const MAINTAINER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const FORK_OWNER = "e".repeat(64);

const address = parseGitRepositoryAddress(`30617:${OWNER}:armada`)!;
const otherAddress = parseGitRepositoryAddress(`30617:${OWNER}:client`)!;
const forkCoordinate = `30617:${FORK_OWNER}:armada`;

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: OWNER,
    created_at: 100,
    kind: GIT_ISSUE_KIND,
    content: "",
    tags: [],
    sig: "0".repeat(128),
    ...overrides,
  };
}

function attachment(overrides: Partial<GitRepositoryAttachment> = {}): GitRepositoryAttachment {
  return { address, relayHints: ["wss://relay.example/"], attachedAt: 1_000, ...overrides };
}

function announcement(): NostrEvent {
  return event({
    id: "a".repeat(64),
    kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
    created_at: 50,
    tags: [
      ["d", "armada"],
      ["name", "Armada"],
      ["description", "Encrypted communities"],
      ["maintainers", MAINTAINER],
      ["clone", "https://git.example/armada.git"],
      ["web", "https://gitworkshop.dev/armada"],
    ],
  });
}

function issue(id: string, createdAt: number, repoTags: string[] = [address.coordinate]): NostrEvent {
  return event({
    id: id.repeat(64).slice(0, 64),
    kind: GIT_ISSUE_KIND,
    pubkey: AUTHOR,
    created_at: createdAt,
    content: "body",
    tags: [...repoTags.map((coordinate) => ["a", coordinate]), ["subject", `Issue ${id}`]],
  });
}

function status(id: string, ticketId: string, kind: number, author: string, createdAt: number): NostrEvent {
  return event({
    id: id.repeat(64).slice(0, 64),
    kind,
    pubkey: author,
    created_at: createdAt,
    tags: [["e", ticketId.repeat(64).slice(0, 64), "", "root"], ["a", address.coordinate]],
  });
}

describe("gitProjectSources", () => {
  it("folds active attachments across channels and drops detached ones", () => {
    const sources = gitProjectSources(
      new Map([
        ["chan1", [attachment({ relayHints: ["wss://one.example/"] })]],
        ["chan2", [attachment({ relayHints: ["wss://two.example/"], attachedAt: 500 })]],
        ["chan3", [attachment({ address: otherAddress, detachedAt: 2_000 })]],
      ]),
      new Map([["chan1", "general"], ["chan2", "dev"], ["chan3", "old"]]),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].address.coordinate).toBe(address.coordinate);
    expect(sources[0].relayHints).toEqual(["wss://one.example/", "wss://two.example/"]);
    expect(sources[0].channels).toEqual(["general", "dev"]);
    expect(sources[0].attachedAt).toBe(500);
  });
});

describe("assembleGitProjects", () => {
  const sources = gitProjectSources(
    new Map([["chan1", [attachment()]]]),
    new Map([["chan1", "engineering"]]),
  );

  it("includes full history, not just the attachment interval", () => {
    const { items, activities } = assembleGitProjects(sources, [announcement(), issue("2", 10)]);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Issue 2");
    expect(activities.some((activity) => activity.type === "ticket-opened" && activity.createdAt === 10)).toBe(true);
  });

  it("matches a ticket that lists a fork's repository first", () => {
    const { items } = assembleGitProjects(sources, [issue("3", 10, [forkCoordinate, address.coordinate])]);
    expect(items).toHaveLength(1);
    expect(items[0].repoCoord).toBe(address.coordinate);
  });

  it("resolves status from trusted authors only", () => {
    const closedByStranger = assembleGitProjects(sources, [
      announcement(),
      issue("2", 10),
      status("4", "2", GIT_STATUS_CLOSED_KIND, STRANGER, 20),
    ]);
    expect(closedByStranger.items[0].status).toBe("open");

    const closedByMaintainer = assembleGitProjects(sources, [
      announcement(),
      issue("2", 10),
      status("4", "2", GIT_STATUS_CLOSED_KIND, MAINTAINER, 20),
    ]);
    expect(closedByMaintainer.items[0].status).toBe("closed");
  });

  it("maps applied statuses by ticket type", () => {
    const resolved = assembleGitProjects(sources, [
      announcement(),
      issue("2", 10),
      status("4", "2", GIT_STATUS_APPLIED_KIND, OWNER, 20),
    ]);
    expect(resolved.items[0].status).toBe("resolved");

    const pr = event({
      id: "5".repeat(64),
      kind: GIT_PULL_REQUEST_KIND,
      pubkey: AUTHOR,
      created_at: 10,
      tags: [["a", address.coordinate], ["subject", "A change"]],
    });
    const merged = assembleGitProjects(sources, [
      announcement(),
      pr,
      status("6", "5", GIT_STATUS_APPLIED_KIND, OWNER, 20),
    ]);
    expect(merged.items[0].status).toBe("merged");
    expect(merged.items[0].kind).toBe("pr");
  });

  it("falls back to the coordinate when no announcement is known", () => {
    const { repos } = assembleGitProjects(sources, []);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("armada");
    expect(repos[0].createdAt).toBe(1_000);
    expect(repos[0].subtitle).toBe("#engineering");
  });

  it("fills repository metadata from the newest announcement", () => {
    const { repos } = assembleGitProjects(sources, [announcement()]);
    expect(repos[0].name).toBe("Armada");
    expect(repos[0].contributors).toEqual([MAINTAINER]);
    expect(repos[0].cloneUrls).toEqual(["https://git.example/armada.git"]);
    expect(repos[0].webUrl).toBe("https://gitworkshop.dev/armada");
  });

  it("surfaces comments as ungated panel activities", () => {
    const comment = event({
      id: "7".repeat(64),
      kind: NIP22_COMMENT_KIND,
      pubkey: STRANGER,
      created_at: 30,
      content: "A drive-by remark",
      tags: [["E", "2".repeat(64), "", AUTHOR], ["K", String(GIT_ISSUE_KIND)], ["P", AUTHOR]],
    });
    const { activities, ticketsById } = assembleGitProjects(sources, [announcement(), issue("2", 10), comment]);
    expect(ticketsById.has("2".repeat(64))).toBe(true);
    expect(activities.some((activity) => activity.type === "comment" && activity.comment.content === "A drive-by remark")).toBe(true);
  });
});

describe("labels and comment counts", () => {
  const sources = gitProjectSources(
    new Map([["chan1", [attachment()]]]),
    new Map([["chan1", "engineering"]]),
  );
  const labeled = event({
    id: "2".repeat(64),
    kind: GIT_ISSUE_KIND,
    pubkey: AUTHOR,
    created_at: 10,
    tags: [["a", address.coordinate], ["subject", "Tagged"], ["t", "Bug"], ["t", "ui"]],
  });
  const comment = (id: string, author: string) => event({
    id: id.repeat(64).slice(0, 64),
    kind: NIP22_COMMENT_KIND,
    pubkey: author,
    created_at: 30,
    tags: [["E", "2".repeat(64), "", AUTHOR], ["K", String(GIT_ISSUE_KIND)]],
  });

  it("exposes lowercased labels and counts comments", () => {
    const { items } = assembleGitProjects(sources, [labeled, comment("7", STRANGER), comment("8", AUTHOR)]);
    expect(items[0].labels).toEqual(["bug", "ui"]);
    expect(items[0].commentCount).toBe(2);
  });

  it("does not count retracted comments", () => {
    const retraction = event({
      id: "9".repeat(64),
      kind: 5,
      pubkey: STRANGER,
      created_at: 40,
      tags: [["e", "7".repeat(64)]],
    });
    const { items } = assembleGitProjects(sources, [labeled, comment("7", STRANGER), comment("8", AUTHOR), retraction]);
    expect(items[0].commentCount).toBe(1);
  });
});
