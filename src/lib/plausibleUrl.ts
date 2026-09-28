/**
 * Sanitize a page URL before reporting it to Plausible: dynamic routes (DM
 * peers, servers, communities, event ids, invites, profiles) collapse to their
 * templates, and query + hash are always dropped. Chat routes are templated
 * via the app's own `parseChatRoute`, so an unknown route shape can't leak an id.
 */

import { chatRouteTemplate, parseChatRoute } from "@/lib/routes";

/** Non-chat dynamic routes, which have no builder to derive a template from. */
const OTHER_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/invite\/[^/]+$/, "/invite/:naddr"],
];

/**
 * Static top-level routes; any other single segment is `/:user` (an npub or
 * NIP-05). An allowlist, because a missing static route only costs an aggregate
 * while a missing identifier pattern would leak a pubkey.
 */
const STATIC_TOP_LEVEL = new Set([
  "welcome",
  "invite",
  "changelog",
  "privacy",
  "terms",
  "share",
  "remoteloginsuccess",
  "discover",
  "mesh",
  "settings",
]);

/** The template for a non-chat path, or `null` when it needs no collapsing. */
function nonChatTemplate(path: string): string | null {
  for (const [pattern, template] of OTHER_TEMPLATES) {
    if (pattern.test(path)) return template;
  }
  const seg = path.split("/").filter(Boolean);
  if (seg.length === 1 && !STATIC_TOP_LEVEL.has(seg[0].toLowerCase())) return "/:user";
  return null;
}

export function sanitizePlausibleUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  let path = url.pathname;
  const chat = parseChatRoute(path);
  if (chat) {
    path = chatRouteTemplate(chat);
  } else {
    path = nonChatTemplate(path) ?? path;
  }

  // Query/hash may carry invite secrets or login tokens.
  return `${url.origin}${path}`;
}
