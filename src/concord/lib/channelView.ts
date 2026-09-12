/**
 * Channel view — CORD-03 §2's optional `view` field on ChannelMetadata.
 *
 * A Channel is one Chat Plane whichever value it carries; `view` only names
 * how a client should OPEN it: `"chat"` (the default, and what an absent
 * field means) or `"forum"`, which opens thread-first — titled posts (§3,
 * `forum.ts`) listed as a feed, each opening onto its own thread, with the
 * plain timeline still reachable as an alternate view.
 *
 * It is a protocol-level field, deliberately NOT an `armada.`-prefixed
 * `custom` key like `armada.category`: a vendor key is round-tripped and
 * ignored by every other Concord client, so a forum filed that way would open
 * as an ordinary text channel in Vector. As a spec field every CORD client
 * reads the same forum.
 *
 * Two rules the spec sets and this module keeps: an unknown value reads as
 * `"chat"` rather than being refused (so the set can grow additively), and an
 * editor MUST round-trip the field — every `with…` helper here and in
 * `channelCategory.ts` spreads the metadata it was given, so a rename from a
 * chat-only client never silently flattens a forum.
 */

import type { ChannelMetadata, ChannelView } from "@/concord/lib/types";

export type { ChannelView };

/** The channel's declared view; absent, unknown or malformed reads as `"chat"`. */
export function channelView(metadata: ChannelMetadata): ChannelView {
  return metadata.view === "forum" ? "forum" : "chat";
}

/**
 * Metadata with the view set, everything else untouched. `"chat"` is written
 * as an ABSENT field — it is the default, and two clients holding the same
 * state should serialize the same bytes.
 */
export function withChannelView(metadata: ChannelMetadata, view: ChannelView): ChannelMetadata {
  const next: ChannelMetadata = { ...metadata };
  if (view === "chat") delete next.view;
  else next.view = view;
  return next;
}
