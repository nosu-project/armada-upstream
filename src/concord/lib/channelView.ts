/**
 * CORD-03 §2's optional `view` field: `"chat"` (default/absent) or `"forum"`
 * (thread-first; see `forum.ts`). A spec field, not an `armada.` custom key, so
 * other CORD clients open the same forum. Unknown values read as `"chat"`, and
 * editors MUST round-trip it (every `with…` helper spreads the given metadata).
 */

import type { ChannelMetadata, ChannelView } from "@/concord/lib/types";

export type { ChannelView };

/** The channel's declared view; absent, unknown or malformed reads as `"chat"`. */
export function channelView(metadata: ChannelMetadata): ChannelView {
  return metadata.view === "forum" ? "forum" : "chat";
}

/**
 * Metadata with the view set. `"chat"` is written as an ABSENT field, so equal
 * state serializes to equal bytes.
 */
export function withChannelView(metadata: ChannelMetadata, view: ChannelView): ChannelMetadata {
  const next: ChannelMetadata = { ...metadata };
  if (view === "chat") delete next.view;
  else next.view = view;
  return next;
}
