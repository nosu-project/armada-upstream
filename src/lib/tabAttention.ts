import { renderBadgedFavicon } from "@/lib/faviconBadge";

/**
 * The inactive-tab unread cue: a dot drawn ON the favicon.
 *
 * Deliberately not a character prefixed to `document.title` — that spells the
 * marker into text the user reads (and that bookmarks, history entries and
 * window titles then carry), where the whole convention for "there is
 * something waiting" is a badge on the icon.
 *
 * While badged, the document's own icon links are DETACHED and a single
 * `data:` URL link stands in their place. Leaving them in would let the
 * browser go on picking among them — the choice is per-browser and per-DPI,
 * so the badge would appear only sometimes.
 */

/** Identifies the stand-in link, so a re-entrant call can find its own work. */
const BADGE_LINK_ID = "armada-favicon-badge";

/** Whether a cue is outstanding. Cleared when the user comes back to the tab. */
let marked = false;
/** The rendered badge, kept for the life of the page (the icon never changes). */
let badgedHref: string | null = null;
/** In-flight render, so a burst of notifications rasterizes once. */
let rendering: Promise<string | null> | null = null;
/** Set when rendering has proven impossible here; stops per-message retries. */
let unsupported = false;
/** The document's real icon links, held while the badge stands in for them. */
let detachedIcons: HTMLLinkElement[] = [];

function isTabActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
    .filter((link) => link.id !== BADGE_LINK_ID);
}

/**
 * The icon to badge: the SVG one by preference (it rasterizes cleanly at any
 * size), else whatever else is declared, else the build's own default.
 */
function baseIconHref(): string {
  const links = iconLinks();
  const svg = links.find((link) => link.type === "image/svg+xml");
  return (svg ?? links[0])?.href || "/favicon.svg";
}

function badgedIcon(): Promise<string | null> {
  if (badgedHref) return Promise.resolve(badgedHref);
  if (unsupported) return Promise.resolve(null);
  rendering ??= renderBadgedFavicon(baseIconHref())
    .catch(() => null)
    .then((href) => {
      rendering = null;
      if (href) badgedHref = href;
      else unsupported = true;
      return href;
    });
  return rendering;
}

function showBadge(href: string): void {
  if (document.getElementById(BADGE_LINK_ID)) return;
  const icons = iconLinks();
  const link = document.createElement("link");
  link.id = BADGE_LINK_ID;
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
  for (const icon of icons) icon.remove();
  detachedIcons = icons;
}

function hideBadge(): void {
  document.getElementById(BADGE_LINK_ID)?.remove();
  // Re-appended in their original order; only their order relative to each
  // other decides anything.
  for (const icon of detachedIcons) document.head.appendChild(icon);
  detachedIcons = [];
}

/**
 * Badge the favicon when Armada is away. Returns whether the tab was inactive,
 * i.e. whether a cue was called for at all — the badge itself is applied on the
 * next tick, once the icon has been rasterized.
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
