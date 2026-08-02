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
 * - `/invite/:naddr` leaks the invited resource; an invite **secret** may also
 *   ride along in the query string or `#` fragment.
 *
 * This collapses each dynamic route back to its route *template* and drops the
 * query string and hash entirely. Operators still get useful per-route
 * aggregates ("how many people opened a DM / a community") with no identifier
 * or secret ever leaving the client. Static routes pass through unchanged;
 * unknown paths keep only their pathname (query/hash stripped) as a safe
 * default.
 */

/** Ordered path patterns → route template. Longer/more specific first. */
const ROUTE_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/s\/[^/]+\/projects$/, "/s/:server/projects"],
  [/^\/s\/[^/]+\/inbox$/, "/s/:server/inbox"],
  [/^\/s\/[^/]+\/[^/]+$/, "/s/:server/:groupId"],
  [/^\/s\/[^/]+$/, "/s/:server"],
  [/^\/c1\/[^/]+\/[^/]+$/, "/c1/:communityId/:channelId"],
  [/^\/c1\/[^/]+$/, "/c1/:communityId"],
  [/^\/c\/[^/]+\/[^/]+$/, "/c/:communityId/:channelId"],
  [/^\/c\/[^/]+$/, "/c/:communityId"],
  [/^\/invite\/[^/]+$/, "/invite/:naddr"],
  [/^\/dm\/[^/]+$/, "/dm/:peer"],
  // Pre-rename path. Kept because a stale link (an old push subscription, a
  // tray notification) lands on it and AppRouter's redirect can report the
  // pageview before it replaces — the peer pubkey is there either way.
  [/^\/dms\/[^/]+$/, "/dm/:peer"],
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
  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(path)) {
      path = template;
      break;
    }
  }

  // Always drop query + hash: they may carry invite secrets or login tokens.
  return `${url.origin}${path}`;
}
