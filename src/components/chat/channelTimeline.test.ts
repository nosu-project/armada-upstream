import { describe, expect, it } from "vitest";

import { isCommunityGuest, isGitContinuation, mergeChannelTimeline } from "./channelTimeline";
import type { ChatMsg } from "./transport";
import type { GitTimelineActivity } from "@/lib/gitActivity";

const pk = "a".repeat(64);
const chat = (id: string, created_at: number): ChatMsg => ({ id, pubkey: pk, created_at, kind: 9, content: "chat", tags: [] });
const ticket = { id: "b".repeat(64), kind: 1621 as const, type: "issue" as const, subject: "Ticket", content: "", labels: [], repositoryAddresses: [], author: pk, createdAt: 10, event: { id: "b".repeat(64), pubkey: pk, created_at: 10, kind: 1621, content: "", tags: [] } };
const git = (id: string, createdAt: number): GitTimelineActivity => ({ type: "comment", createdAt, ticket, repository: { kind: 30617, owner: pk, identifier: "repo", coordinate: `30617:${pk}:repo` }, comment: { id, ticketId: ticket.id, ticketKind: 1621, content: "comment", author: pk, createdAt, event: { id, pubkey: pk, created_at: createdAt, kind: 1111, content: "comment", tags: [] } } });

describe("mixed channel timeline", () => {
  it("merges chat and Git chronologically with a deterministic id tie-break", () => {
    expect(mergeChannelTimeline([chat("z", 20), chat("a", 10)], [git("c", 20)]).map((entry) => entry.id)).toEqual(["chat:a", "chat:z", "git:c"]);
  });

  it("marks only roster members as community members", () => {
    expect(isCommunityGuest(pk, new Set())).toBe(true);
    expect(isCommunityGuest(pk, new Set([pk]))).toBe(false);
  });

  it("groups only adjacent comments on the same ticket", () => {
    const comments = mergeChannelTimeline([], [git("c", 20), git("d", 21)]);
    expect(isGitContinuation(comments[0], comments[1])).toBe(true);
    const interrupted = mergeChannelTimeline([chat("x", 21)], [git("c", 20), git("d", 22)]);
    expect(isGitContinuation(interrupted[0], interrupted[1])).toBe(false);
  });
});
