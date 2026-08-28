/**
 * Recognize a URL that points back into this app — a copied message link or a
 * channel/server share built by `chatUrl()`, or a bare profile link
 * (`<origin>/<npub>`) — so the renderer can treat it as the in-app location it
 * names instead of an external website: navigated with the router rather than
 * a new tab, and rendered as the thing it points at.
 *
 * "Ours" is a set of origins, not one: the page's own origin (a self-hosted
 * deployment's links stay on that deployment) plus the public deployment,
 * which is what native and desktop builds put in every link they generate
 * (`shareOrigin()`) — so an armada.buzz link pasted into a self-hosted web
 * client still reads as internal. Anything that doesn't parse to a known
 * shape falls through to ordinary link rendering; this never claims a URL it
 * can't route.
 */

import { nip19 } from "nostr-tools";

import { isRouterPath } from "@/lib/deepLinkUrl";
import { parseChatRoute, type ChatRoute } from "@/lib/routes";
import { PUBLIC_WEB_ORIGIN, shareOrigin } from "@/lib/shareOrigin";

/** A URL resolved to an in-app destination. */
export type SelfLink =
  /** A chat location — the router path preserves any search/hash. */
  | { kind: "chat"; route: ChatRoute; path: string }
  /** A profile link (`/<npub>` or `/<nprofile>`). */
  | { kind: "profile"; pubkey: string };

/** The origins whose links are ours to route, normalized via `URL`. */
function ownOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [shareOrigin(), PUBLIC_WEB_ORIGIN]) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Unparseable origin (e.g. a bad VITE_PUBLIC_WEB_ORIGIN) — skip it.
    }
  }
  return origins;
}

/**
 * Parse a URL into the in-app destination it names, or `null` when it isn't
 * one of ours (wrong origin, a static page, an invite — invites have their
 * own card and are matched by path before this runs).
 */
export function parseSelfLink(url: string): SelfLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!ownOrigins().has(u.origin)) return null;

  // `new URL("https://a//x").pathname` is "//x" — a protocol-relative URL when
  // handed to the router, not a path. Same guard the deep-link path applies.
  const path = u.pathname + u.search + u.hash;
  if (!isRouterPath(path)) return null;

  const route = parseChatRoute(u.pathname);
  if (route) return { kind: "chat", route, path };

  // The `/:user` route: a single path segment that decodes as a profile id.
  // A NIP-05 name (or any other single segment) is left alone — it can't be
  // resolved to a pubkey without a fetch, and over-claiming would swallow
  // static pages.
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length === 1) {
    try {
      const decoded = nip19.decode(decodeURIComponent(seg[0]));
      if (decoded.type === "npub") return { kind: "profile", pubkey: decoded.data };
      if (decoded.type === "nprofile") return { kind: "profile", pubkey: decoded.data.pubkey };
    } catch {
      // not a nostr identifier
    }
  }

  return null;
}
