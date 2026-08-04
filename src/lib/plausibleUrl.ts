/**
 * Sanitizes a page URL before it is reported to Plausible.
 *
 * Armada uses `<BrowserRouter>`, so `location.href` (which the tracker sends as
 * the event URL) embeds identifiers that would de-anonymize a visitor and break
 * the cookieless "we don't track individuals" posture:
 *
 * - `/dm/:peer` leaks the DM counterparty's pubkey.
 * - `/s/:server`, `/s/:server/:groupId` leak which relay/server + group.
 * - `/c1/:communityId`, `/c/:communityId/:channelId` leak which community/channel.
 * - `/c/…/m/:messageId` and `/c/…/t/:threadRoot` leak individual event ids.
 * - `/invite/:naddr` leaks the invited resource; an invite **secret** may also
 *   ride along in the query string or `#` fragment.
 * - `/:user` leaks whose profile was viewed — a pubkey, a NIP-05 address, or a
 *   domain.
 *
 * This collapses each dynamic route back to its route *template* and drops the
 * query string and hash entirely. Operators still get useful per-route
 * aggregates ("how many people opened a DM / a community") with no identifier
 * or secret ever leaving the client. Static routes pass through unchanged; an
 * unrecognized single segment is reported as `/:user`, since that is the route
 * it actually renders, and any deeper unknown path keeps only its pathname
 * (query/hash stripped) as a safe default.
 *
 * Chat routes are collapsed by **parsing them with the same module the app
 * navigates by** (`parseChatRoute` → `chatRouteTemplate`) rather than by
 * matching a list of patterns maintained alongside the router. Message and
 * thread ids live in the pathname, so the query-string strip below is no longer
 * a backstop for them: a route shape this file didn't know about used to be
 * merely under-reported, and would now leak an event id. Deriving the template
 * from the parse makes that class of drift impossible rather than unlikely.
 */

import { chatRouteTemplate, parseChatRoute } from "@/lib/routes";

/** Non-chat dynamic routes, which have no builder to derive a template from. */
const OTHER_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/invite\/[^/]+$/, "/invite/:naddr"],
];

/**
 * Top-level paths that name a page rather than a person.
 *
 * `/:user` is declared last in `AppRouter`, but React Router ranks static
 * segments above dynamic ones regardless of order, so it matches every single
 * segment that isn't one of these — meaning an npub, a NIP-05 address or a
 * domain would otherwise reach Plausible verbatim in the pathname.
 *
 * This is an allowlist of the static routes rather than a pattern for the
 * identifier forms, because the two directions of drift are not equally
 * costly: a new static route missing from here is merely reported as `/:user`
 * (one aggregate lost), while an identifier shape missing from a pattern is a
 * pubkey shipped to a third party. Compared case-insensitively, as React
 * Router matches.
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
    // Not a parseable absolute URL; report nothing revealing.
    return rawUrl;
  }

  let path = url.pathname;
  const chat = parseChatRoute(path);
  if (chat) {
    path = chatRouteTemplate(chat);
  } else {
    path = nonChatTemplate(path) ?? path;
  }

  // Always drop query + hash: they may carry invite secrets or login tokens.
  return `${url.origin}${path}`;
}
