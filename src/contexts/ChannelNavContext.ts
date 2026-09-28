import { createContext } from "react";

/**
 * Lets chat pages publish a resolver so {@link ChatContent} navigates `#tag` to a
 * matching local channel instead of Ditto's hashtag feed (null → fall back).
 */
export interface ChannelNavValue {
  /** Resolve a bare hashtag to a local channel's navigation handler, or `null`. Case- and slug-insensitive. */
  resolveChannelByName: (tag: string) => (() => void) | null;
}

export const ChannelNavContext = createContext<ChannelNavValue | undefined>(undefined);

/** Normalize for comparison: lowercase, trim, collapse non-alphanumeric runs to "-". */
export function normalizeChannelKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
