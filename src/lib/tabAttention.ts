import { renderBadgedFavicon } from "@/lib/faviconBadge";

/**
 * Inactive-tab unread cue: a dot badge on the favicon (not a title prefix).
 * While badged, the real icon links are DETACHED and one `data:` link stands
 * in, since browsers pick among multiple icons inconsistently.
 */

const BADGE_LINK_ID = "armada-favicon-badge";

/** Whether a cue is outstanding. Cleared when the user comes back to the tab. */
let marked = false;
/** The rendered badge, kept for the life of the page (the icon never changes). */
let badgedHref: string | null = null;
/** In-flight render, so a burst of notifications rasterizes once. */
let rendering: Promise<string | null> | null = null;
/** Set when rendering has proven impossible here; stops per-message retries. */
let unsupported = false;
/** When a failed render may retry (a network blip shouldn't disable the badge forever). */
let retryAt = 0;
const RETRY_DELAY_MS = 60_000;
/** The document's real icon links, held while the badge stands in for them. */
let detachedIcons: HTMLLinkElement[] = [];

function isTabActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
    .filter((link) => link.id !== BADGE_LINK_ID);
}

/** The icon to badge: SVG preferred, else any declared icon, else the default. */
function baseIconHref(): string {
  const links = iconLinks();
  const svg = links.find((link) => link.type === "image/svg+xml");
  return (svg ?? links[0])?.href || "/favicon.svg";
}

function badgedIcon(): Promise<string | null> {
  if (badgedHref) return Promise.resolve(badgedHref);
  if (unsupported || (!rendering && Date.now() < retryAt)) return Promise.resolve(null);
  rendering ??= renderBadgedFavicon(baseIconHref())
    .then((href) => {
      if (href) badgedHref = href;
      else unsupported = true;
      return href;
    }, () => {
      retryAt = Date.now() + RETRY_DELAY_MS;
      return null;
    })
    .finally(() => { rendering = null; });
  return rendering;
}

function showBadge(href: string): void {
  if (document.getElementById(BADGE_LINK_ID)) return;
  // Detach FIRST, then append: Brave keeps the old icon otherwise.
  const icons = iconLinks();
  for (const icon of icons) icon.remove();
  detachedIcons = icons;
  const link = document.createElement("link");
  link.id = BADGE_LINK_ID;
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
}

function hideBadge(): void {
  document.getElementById(BADGE_LINK_ID)?.remove();
  for (const icon of detachedIcons) document.head.appendChild(icon);
  detachedIcons = [];
}

/**
 * Badge the favicon when the tab is inactive. Returns whether a cue was called
 * for; the badge lands after rasterizing.
 */
export function markTabAttention(): boolean {
  if (typeof document === "undefined" || isTabActive()) return false;
  marked = true;
  void badgedIcon().then((href) => {
    // The user may have come back while this was rendering.
    if (href && marked) showBadge(href);
  });
  return true;
}

export function clearTabAttention(): void {
  if (typeof document === "undefined") return;
  marked = false;
  hideBadge();
}

/** Clear the marker only after this tab is both visible and focused. */
export function installTabAttentionClearHandlers(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  const clearWhenActive = () => {
    if (isTabActive()) clearTabAttention();
  };
  document.addEventListener("visibilitychange", clearWhenActive);
  window.addEventListener("focus", clearWhenActive);

  return () => {
    document.removeEventListener("visibilitychange", clearWhenActive);
    window.removeEventListener("focus", clearWhenActive);
    clearTabAttention();
  };
}
