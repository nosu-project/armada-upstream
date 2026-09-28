import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, type ChatRoute } from "@/lib/routes";

/**
 * Redirect legacy `?thread=` / `?m=` links to their path routes. They can't be retired:
 * Android notifications, stored web-push payloads and copied links outlive builds (same as `/dms`
 * in `AppRouter`). `base` is `undefined` while resolving; other params (e.g. `?ticket=`) ride along.
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
    // DMs have no thread panel, so `?thread=` is dropped there.
    const path = chatRoute(
      base.kind === "dm" ? { ...base, messageId } : { ...base, threadRoot, messageId },
    );
    const target = `${path}${rest ? `?${rest}` : ""}${hash}`;

    // `replace` so Back doesn't bounce through a redirecting URL.
    navigate(target, { replace: true });
  }, [base, search, hash, navigate]);
}
