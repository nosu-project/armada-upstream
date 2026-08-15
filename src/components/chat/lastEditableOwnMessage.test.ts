/**
 * `lastEditableOwnMessage` backs the "ArrowUp in an empty composer edits your
 * last message" gesture, and it MUST agree with `ChatMessage`'s `canEdit`: the
 * message is the user's own, is plain chat text (NIP-29 kind 9 or NIP-17 kind
 * 14 — never a poll/file/forum-post structured row), and is not a still-pending
 * optimistic send. A drift here would open an edit the row itself refuses to
 * offer, or skip one it does.
 */

import { describe, expect, it } from "vitest";

import { lastEditableOwnMessage } from "@/components/chat/transport";
import type { ChatMsg } from "@/components/chat/transport";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);

function msg(id: string, createdAt: number, pubkey: string, kind = 9): ChatMsg {
  return { id, pubkey, created_at: createdAt, kind, content: `msg ${id}`, tags: [], sig: "" } as unknown as ChatMsg;
}

describe("lastEditableOwnMessage", () => {
  it("returns the newest own message (last in an oldest-first list)", () => {
    const messages = [
      msg("1", 100, ME),
      msg("2", 200, THEM),
      msg("3", 300, ME),
    ];
    expect(lastEditableOwnMessage(messages, ME)?.id).toBe("3");
  });

  it("skips others' newer messages to find your own", () => {
    const messages = [
      msg("1", 100, ME),
      msg("2", 200, THEM),
      msg("3", 300, THEM),
    ];
    expect(lastEditableOwnMessage(messages, ME)?.id).toBe("1");
  });

  it("returns undefined when you have no message in the list", () => {
    const messages = [msg("1", 100, THEM), msg("2", 200, THEM)];
    expect(lastEditableOwnMessage(messages, ME)).toBeUndefined();
  });

  it("returns undefined without a user pubkey", () => {
    const messages = [msg("1", 100, ME)];
    expect(lastEditableOwnMessage(messages, undefined)).toBeUndefined();
  });

  it("accepts NIP-17 kind-14 chat but rejects other kinds (polls, files, forum posts, legacy kind-4)", () => {
    expect(lastEditableOwnMessage([msg("1", 100, ME, 14)], ME)?.id).toBe("1");
    for (const kind of [1068, 15, 45001, 4]) {
      expect(lastEditableOwnMessage([msg("1", 100, ME, kind)], ME)).toBeUndefined();
    }
  });

  it("skips your newest message while it is a pending optimistic send, falling back to the prior one", () => {
    const messages = [msg("1", 100, ME), msg("2", 200, ME)];
    const pending = (id: string) => id === "2";
    expect(lastEditableOwnMessage(messages, ME, pending)?.id).toBe("1");
  });

  it("returns undefined when every own message is still pending", () => {
    const messages = [msg("1", 100, ME), msg("2", 200, ME)];
    expect(lastEditableOwnMessage(messages, ME, () => true)).toBeUndefined();
  });
});
