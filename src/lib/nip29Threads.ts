/**
 * NIP-29 threads, in Buzz's convention (NIP-CW, which Amethyst also reads): a
 * thread reply is a kind 9 with a NIP-10 MARKED `reply` `e` tag, so every
 * NIP-29 client still receives it as chat. One flagged `["broadcast","1"]` also
 * stays on the timeline. Kind-1111 NIP-22 comments, which Armada sent before and
 * only Armada and Amethyst render under a chat message, are read, never sent.
 */

import { buzzThreadRef, isBroadcastReply } from "@/buzz/protocol";

const KIND_GROUP_CHAT = 9;
const KIND_COMMENT = 1111;

interface TaggedEvent {
  kind: number;
  tags: string[][];
}

/** The thread root an event replies into, or undefined for a timeline message. */
export function nip29ThreadRootOf(event: TaggedEvent): string | undefined {
  if (event.kind === KIND_COMMENT) return event.tags.find(([n, v]) => n === "E" && v)?.[1];
  if (event.kind !== KIND_GROUP_CHAT) return undefined;
  return buzzThreadRef(event.tags).rootId || undefined;
}

/** Whether an event lives only in its thread, never as a timeline row. */
export function isNip29ThreadOnly(event: TaggedEvent): boolean {
  if (event.kind === KIND_COMMENT) return true;
  return nip29ThreadRootOf(event) !== undefined && !isBroadcastReply(event.tags);
}

/**
 * Tags for a kind-9 thread reply to `root` (Buzz's `buildReplyTags`, with the
 * parent always the root since the panel is flat), plus a NIP-C7 `q` so a
 * client without threads still shows what it answers. A root that is itself a
 * legacy kind-1111 comment hands on its own root.
 */
export function buildNip29ThreadReplyTags(
  root: { id: string; kind: number; pubkey: string; tags: string[][] },
  groupId: string,
  relayUrl: string,
): string[][] {
  const rootId = nip29ThreadRootOf(root) ?? root.id;
  const tags: string[][] = [["h", groupId]];
  if (rootId === root.id) {
    tags.push(["e", root.id, "", "reply"]);
  } else {
    tags.push(["e", rootId, "", "root"]);
    tags.push(["e", root.id, "", "reply"]);
  }
  tags.push(["q", root.id, relayUrl, root.pubkey]);
  tags.push(["p", root.pubkey]);
  return tags;
}
