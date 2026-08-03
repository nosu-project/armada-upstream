import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, type ChatRoute } from "@/lib/routes";

/**
 * Translate the pre-path `?thread=<rootId>` and `?m=<eventId>` links into the
 * route shapes that replaced them.
 *
 * These spellings cannot be retired by shipping a build that stops producing
 * them, because the things that produce them live outside it and outlast it:
 * an Android tray notification carries its `armada://open/...` PendingIntent
 * across an app update, a web-push subscription's stored payload sits on the
 * relay until the client next re-registers, and a link someone copied and sent
 * is permanent. The same reasoning keeps `/dms` redirecting in `AppRouter`.
 *
 * Redirecting (rather than consuming the params in place) means there is still
 * exactly one representation of an open thread or a focused message — the
 * path — so nothing downstream has to know both spellings.
 *
 * `base` is the room the caller is in; pass `undefined` while it is still
 * resolving. Any other query parameter rides along untouched, which is what
 * keeps `?ticket=` working.
 */
export function useLegacyFocusParams(base: ChatRoute | undefined): void {
  const navigate = useNavigate();
  const { search, hash } = useLocation();

  useEffect(() => {
    if (!base) return;
    const params = new URLSearchParams(search);
    const threadRoot = params.get("thread") ?? undefined;
    const messageId = params.get("m") ?? undefined;
    if (!threadRoot && !messageId) return;

    params.delete("thread");
    params.delete("m");
    const rest = params.toString();
    // DMs have no thread panel, so a `?thread=` there names nothing and is
    // dropped rather than encoded into a route that cannot render.
    const path = chatRoute(
      base.kind === "dm" ? { ...base, messageId } : { ...base, threadRoot, messageId },
    );
    const target = `${path}${rest ? `?${rest}` : ""}${hash}`;

    // `replace`: the reader asked for the destination, not for the spelling
    // the link happened to use, so Back should leave the room rather than
    // bounce through a URL that immediately redirects again.
    navigate(target, { replace: true });
  }, [base, search, hash, navigate]);
}
