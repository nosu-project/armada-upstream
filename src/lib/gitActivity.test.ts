import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_APPLIED_KIND,
  GIT_STATUS_CLOSED_KIND,
  NIP22_COMMENT_KIND,
  attachGitRepository,
  buildGitCommentTemplate,
  buildGitIssueTemplate,
  buildGitStatusTemplate,
  buildGitTimelineActivities,
  detachGitRepository,
  trustedGitStatusAuthors,
  gitStatusFromKind,
  isGitRepositoryAttachedAt,
  normalizeGitRepositoryAttachments,
  parseGitComment,
  parseGitRepositoryAddress,
  parseGitRepositoryAnnouncement,
  parseGitStatusEvent,
  matchGitTicketRepository,
  parseGitTicket,
  resolveGitTicketStatus,
  sortAndDedupeGitTimelineActivities,
} from "./gitActivity";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const MAINTAINER = "c".repeat(64);
const ATTACKER = "d".repeat(64);

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

function repository() {
  return parseGitRepositoryAnnouncement(event({
    kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
    tags: [["d", "armada"], ["maintainers", MAINTAINER]],
  }))!;
}

describe("parseGitRepositoryAddress", () => {
  it("accepts only canonical repository coordinates", () => {
    expect(parseGitRepositoryAddress(`30617:${OWNER}:armada:client`)).toEqual({
      kind: 30617,
      owner: OWNER,
      identifier: "armada:client",
      coordinate: `30617:${OWNER}:armada:client`,
    });

    expect(parseGitRepositoryAddress(`30617:${OWNER}:`)).toBeUndefined();
    expect(parseGitRepositoryAddress(`30618:${OWNER}:armada`)).toBeUndefined();
    expect(parseGitRepositoryAddress(`30617:${"A".repeat(64)}:armada`)).toBeUndefined();
    expect(parseGitRepositoryAddress("30617:not-a-pubkey:armada")).toBeUndefined();
    expect(parseGitRepositoryAddress("not-a-coordinate")).toBeUndefined();
  });
});

describe("parseGitRepositoryAnnouncement", () => {
  it("preserves repository data and filters URLs", () => {
    const parsed = parseGitRepositoryAnnouncement(event({
      kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
      content: "ignored",
      tags: [
        ["d", "armada"],
        ["name", " Armada client "],
        ["description", " Encrypted communities "],
        ["relays", "wss://relay.example/", "ws://dev.example/", "https://bad.example", "wss://relay.example"],
        ["maintainers", MAINTAINER, MAINTAINER, OWNER, "invalid"],
        ["clone", "https://git.example/armada.git", "http://unsafe.example/repo.git", "nonsense"],
        ["web", "https://git.example/armada", "ftp://bad.example/", "https://git.example/armada"],
      ],
    }));

    expect(parsed).toMatchObject({
      owner: OWNER,
      identifier: "armada",
      name: "Armada client",
      description: "Encrypted communities",
      relays: ["wss://relay.example", "ws://dev.example"],
      maintainers: [MAINTAINER],
      cloneUrls: ["https://git.example/armada.git"],
      webUrls: ["https://git.example/armada"],
    });
  });

  it("falls back to the identifier and rejects missing identifiers or wrong kinds", () => {
    expect(parseGitRepositoryAnnouncement(event({
      kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND,
      tags: [["d", "armada"]],
    }))?.name).toBe("armada");
    expect(parseGitRepositoryAnnouncement(event({ kind: GIT_REPOSITORY_ANNOUNCEMENT_KIND }))).toBeUndefined();
    expect(parseGitRepositoryAnnouncement(event({ kind: 1, tags: [["d", "armada"]] }))).toBeUndefined();
  });
});

describe("ticket, status, and comment parsing", () => {
  it("parses ticket fallbacks, labels, repository address, and PR branches", () => {
    const parsed = parseGitTicket(event({
      id: "2".repeat(64),
      kind: GIT_PULL_REQUEST_KIND,
      pubkey: AUTHOR,
      content: "\n  First meaningful line\n\nBody",
      tags: [
        ["a", `30617:${OWNER}:armada`],
        ["t", "Bug"],
        ["t", "bug"],
        ["branch-name", "feature/git"],
        ["base", "main"],
        ["head", "abc123"],
      ],
    }));

    expect(parsed).toMatchObject({
      type: "pull-request",
      subject: "First meaningful line",
      labels: ["bug"],
      repositoryAddress: { coordinate: `30617:${OWNER}:armada` },
      branches: { name: "feature/git", base: "main", head: "abc123" },
      author: AUTHOR,
    });
    expect(parseGitTicket(event({ kind: 1 }))).toBeUndefined();
    expect(parseGitTicket(event({ content: "\n\n" }))?.subject).toBe("(no subject)");
  });

  it("accepts direct status references and NIP-22 uppercase root comments", () => {
    const ticketId = "2".repeat(64);
    expect(parseGitStatusEvent(event({
      kind: GIT_STATUS_CLOSED_KIND,
      tags: [["e", ticketId, "", "root"]],
    }))?.ticketId).toBe(ticketId);
    expect(parseGitStatusEvent(event({ kind: GIT_STATUS_CLOSED_KIND, tags: [["e", ticketId]] }))?.ticketId).toBe(ticketId);

    expect(parseGitComment(event({
      kind: NIP22_COMMENT_KIND,
      // In NIP-22, the uppercase E tag denotes the root; its fourth value is
      // the root author's pubkey, not the NIP-10 "root" marker.
      tags: [["E", ticketId, "wss://relay.example", AUTHOR], ["K", String(GIT_ISSUE_KIND)], ["P", AUTHOR]],
    }))).toMatchObject({ ticketId, ticketKind: GIT_ISSUE_KIND });
    expect(parseGitComment(event({
      kind: NIP22_COMMENT_KIND,
      tags: [["E", ticketId, "", "root"], ["K", "1"]],
    }))).toBeUndefined();
  });
});

describe("matchGitTicketRepository", () => {
  it("matches a held repository listed after other forks, not just the first `a` tag", () => {
    // A real NIP-34 ticket tags every announcement that adopted it (canonical +
    // forks) and relays match `#a` against any of them. Ours is listed LAST.
    const fork1 = `30617:${"e".repeat(64)}:armada`;
    const fork2 = `30617:${"f".repeat(64)}:armada`;
    const ours = `30617:${OWNER}:armada`;
    const ticket = parseGitTicket(event({
      kind: GIT_ISSUE_KIND,
      tags: [["a", fork1], ["a", fork2], ["a", ours], ["subject", "Something broke"]],
    }))!;

    expect(ticket.repositoryAddresses.map((a) => a.coordinate)).toEqual([fork1, fork2, ours]);
    // The legacy single-address field is the FIRST tag — a fork, not ours.
    expect(ticket.repositoryAddress?.coordinate).toBe(fork1);
    // Matching against what we hold must still find ours, or the whole
    // repository's activity is silently discarded at ingest.
    expect(matchGitTicketRepository(ticket, new Set([ours]))?.coordinate).toBe(ours);
    expect(matchGitTicketRepository(ticket, new Set([`30617:${"9".repeat(64)}:other`]))).toBeUndefined();
  });
});

describe("resolveGitTicketStatus", () => {
  it("only trusts the ticket author, repository owner, or a repository maintainer", () => {
    const ticket = parseGitTicket(event({ id: "2".repeat(64), pubkey: AUTHOR }))!;
    const statuses = [
      event({ id: "4".repeat(64), kind: GIT_STATUS_CLOSED_KIND, pubkey: ATTACKER, created_at: 300, tags: [["e", ticket.id, "", "root"]] }),
      event({ id: "3".repeat(64), kind: GIT_STATUS_APPLIED_KIND, pubkey: MAINTAINER, created_at: 200, tags: [["e", ticket.id, "", "root"]] }),
      // An unrelated ticket's author is not a trusted author for this ticket.
      event({ id: "5".repeat(64), kind: GIT_STATUS_CLOSED_KIND, pubkey: "e".repeat(64), created_at: 400, tags: [["e", ticket.id, "", "root"]] }),
    ];

    const resolved = resolveGitTicketStatus(ticket, repository(), statuses);
    expect(resolved?.event.id).toBe("3".repeat(64));
    expect(gitStatusFromKind(resolved?.kind, ticket.kind)).toBe("resolved");
  });
});

describe("repository attachment intervals", () => {
  it("uses half-open boundaries, normalizes relay hints, and supports reattachment", () => {
    const address = parseGitRepositoryAddress(`30617:${OWNER}:armada`)!;
    const attached = attachGitRepository([], address, ["wss://relay.example/", "wss://relay.example", "https://bad.example"], 10);
    expect(attached[0].relayHints).toEqual(["wss://relay.example"]);
    expect(isGitRepositoryAttachedAt(attached[0], 10)).toBe(true);

    const detached = detachGitRepository(attached, address, 20);
    expect(isGitRepositoryAttachedAt(detached[0], 19)).toBe(true);
    expect(isGitRepositoryAttachedAt(detached[0], 20)).toBe(false);

    const reattached = attachGitRepository(detached, address, ["wss://new.example"], 30);
    expect(reattached).toHaveLength(2);
    expect(isGitRepositoryAttachedAt(reattached[1], 30)).toBe(true);
    expect(normalizeGitRepositoryAttachments([...reattached, reattached[1]])).toHaveLength(2);
  });
});

describe("sortAndDedupeGitTimelineActivities", () => {
  it("deduplicates by underlying event and uses event id as a deterministic time tie-breaker", () => {
    const first = parseGitTicket(event({ id: "a".repeat(64), created_at: 100 }))!;
    const second = parseGitTicket(event({ id: "b".repeat(64), created_at: 100 }))!;
    const sorted = sortAndDedupeGitTimelineActivities([
      { type: "ticket-opened", ticket: second, repository: second.repositoryAddress!, createdAt: 100 },
      { type: "ticket-opened", ticket: first, repository: first.repositoryAddress!, createdAt: 100 },
      { type: "ticket-opened", ticket: first, repository: first.repositoryAddress!, createdAt: 100 },
    ]);

    expect(sorted.map((activity) => {
      expect(activity.type).toBe("ticket-opened");
      return activity.type === "ticket-opened" ? activity.ticket.id : "";
    })).toEqual([first.id, second.id]);
  });
});

describe("buildGitTimelineActivities", () => {
  it("keeps nested comments rooted in known tickets, rejects spoofed statuses, and applies each event interval", () => {
    const address = parseGitRepositoryAddress(`30617:${OWNER}:armada`)!;
    const intervals = [
      { address, relayHints: [], attachedAt: 100, detachedAt: 200 },
      { address, relayHints: [], attachedAt: 300 },
    ];
    const ticket = event({ id: "2".repeat(64), kind: GIT_ISSUE_KIND, pubkey: AUTHOR, created_at: 50, tags: [["a", address.coordinate]] });
    const nestedComment = event({ id: "3".repeat(64), kind: NIP22_COMMENT_KIND, created_at: 150, tags: [["E", ticket.id, "", AUTHOR], ["K", "1621"], ["e", "f".repeat(64), "", "reply"]] });
    const detachedComment = event({ id: "4".repeat(64), kind: NIP22_COMMENT_KIND, created_at: 250, tags: [["E", ticket.id, "", AUTHOR], ["K", "1621"]] });
    const spoof = event({ id: "5".repeat(64), kind: GIT_STATUS_CLOSED_KIND, pubkey: ATTACKER, created_at: 350, tags: [["e", ticket.id, "", "root"]] });
    const trusted = event({ id: "6".repeat(64), kind: GIT_STATUS_CLOSED_KIND, pubkey: MAINTAINER, created_at: 350, tags: [["e", ticket.id, "", "root"]] });
    const unrelated = event({ id: "7".repeat(64), kind: NIP22_COMMENT_KIND, created_at: 150, tags: [["E", "9".repeat(64), "", AUTHOR], ["K", "1621"]] });

    const activities = buildGitTimelineActivities(
      [ticket, nestedComment, detachedComment, spoof, trusted, unrelated],
      intervals,
      [repository()],
    );
    expect(activities.map((activity) => `${activity.type}:${activity.createdAt}`)).toEqual([
      "status-change:350", "comment:150",
    ]);
    expect(activities[1].type === "comment" && activities[1].comment.ticketId).toBe(ticket.id);
  });
});

describe("event template builders", () => {
  const ticket = parseGitTicket(event({
    id: "2".repeat(64),
    kind: GIT_ISSUE_KIND,
    pubkey: AUTHOR,
    created_at: 50,
    tags: [["a", `30617:${OWNER}:armada`], ["subject", "A bug"]],
  }))!;
  const repo = repository();

  function signedAs(template: { kind: number; content: string; tags: string[][] }, pubkey: string): NostrEvent {
    return event({ id: "9".repeat(64), kind: template.kind, pubkey, created_at: 500, content: template.content, tags: template.tags });
  }

  it("builds comments its own parser accepts", () => {
    const template = buildGitCommentTemplate(ticket, "Looks good", "wss://relay.example/");
    const parsed = parseGitComment(signedAs(template, MAINTAINER));
    expect(parsed).toBeDefined();
    expect(parsed!.ticketId).toBe(ticket.id);
    expect(parsed!.ticketKind).toBe(GIT_ISSUE_KIND);
    expect(parsed!.content).toBe("Looks good");
    // NIP-22 parent scope mirrors the root for a top-level comment.
    expect(template.tags.filter(([name]) => name === "e")).toHaveLength(1);
    expect(template.tags.filter(([name]) => name === "k")[0][1]).toBe(String(GIT_ISSUE_KIND));
  });

  it("builds issues its own parser accepts, addressed to owner and maintainers", () => {
    const template = buildGitIssueTemplate(
      { address: repo.address, maintainers: repo.maintainers },
      "Crash on boot",
      "Steps to reproduce",
      "wss://relay.example/",
    );
    const parsed = parseGitTicket(signedAs(template, AUTHOR));
    expect(parsed).toBeDefined();
    expect(parsed!.subject).toBe("Crash on boot");
    expect(parsed!.content).toBe("Steps to reproduce");
    expect(parsed!.repositoryAddress?.coordinate).toBe(repo.address.coordinate);
    const recipients = template.tags.filter(([name]) => name === "p").map(([, value]) => value);
    expect(recipients).toEqual([OWNER, MAINTAINER]);
  });

  it("carries attachment imeta tags without breaking its own parsers", () => {
    const media = [["imeta", "url https://blossom.example/abc.png", "m image/png", "x " + "f".repeat(64)]];
    const comment = buildGitCommentTemplate(ticket, "See screenshot", "", media);
    expect(parseGitComment(signedAs(comment, MAINTAINER))).toBeDefined();
    expect(comment.tags.filter(([name]) => name === "imeta")).toHaveLength(1);

    const issue = buildGitIssueTemplate({ address: repo.address, maintainers: [] }, "Broken layout", "https://blossom.example/abc.png", "", media);
    const parsed = parseGitTicket(signedAs(issue, AUTHOR));
    expect(parsed).toBeDefined();
    expect(issue.tags.filter(([name]) => name === "imeta")).toHaveLength(1);
  });

  it("builds statuses its own parser and trust resolution accept", () => {
    const template = buildGitStatusTemplate(ticket, { address: repo.address, maintainers: repo.maintainers }, GIT_STATUS_CLOSED_KIND, "wss://relay.example/");
    const signed = signedAs(template, MAINTAINER);
    const parsed = parseGitStatusEvent(signed);
    expect(parsed).toBeDefined();
    expect(parsed!.ticketId).toBe(ticket.id);
    expect(resolveGitTicketStatus(ticket, repo, [signed])?.kind).toBe(GIT_STATUS_CLOSED_KIND);
    expect(gitStatusFromKind(parsed!.kind, ticket.kind)).toBe("closed");
  });
});

describe("trustedGitStatusAuthors", () => {
  it("trusts exactly the ticket author, owner and maintainers", () => {
    const ticket = parseGitTicket(event({
      id: "2".repeat(64),
      kind: GIT_ISSUE_KIND,
      pubkey: AUTHOR,
      created_at: 50,
      tags: [["a", `30617:${OWNER}:armada`]],
    }))!;
    const trusted = trustedGitStatusAuthors(ticket, repository());
    expect(trusted.has(AUTHOR)).toBe(true);
    expect(trusted.has(OWNER)).toBe(true);
    expect(trusted.has(MAINTAINER)).toBe(true);
    expect(trusted.has(ATTACKER)).toBe(false);
  });
});
