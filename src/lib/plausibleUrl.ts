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
 *
 * This collapses each dynamic route back to its route *template* and drops the
 * query string and hash entirely. Operators still get useful per-route
 * aggregates ("how many people opened a DM / a community") with no identifier
 * or secret ever leaving the client. Static routes pass through unchanged;
 * unknown paths keep only their pathname (query/hash stripped) as a safe
 * default.
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
    for (const [pattern, template] of OTHER_TEMPLATES) {
      if (pattern.test(path)) {
        path = template;
        break;
      }
    }
  }

  // Always drop query + hash: they may carry invite secrets or login tokens.
  return `${url.origin}${path}`;
}
