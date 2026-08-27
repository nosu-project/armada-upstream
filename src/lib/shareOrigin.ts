/**
 * The origin shareable links are built on (#44).
 *
 * In the browser the page's own origin is correct: the link resolves back to
 * this deployment (including localhost/LAN quickstart installs, whose links
 * are meant to stay on that deployment). In the Capacitor APK, however,
 * `window.location.origin` is the WebView's local server (`https://localhost`)
 * — invite/share links built from it are dead on arrival for everyone they're
 * sent to.
 *
 * The Electron shell has the same problem for the same reason: it serves the
 * bundled SPA over its own `app://armada` scheme, which exists only inside
 * that process.
 *
 * Those builds therefore use the public web deployment, which doubles as the
 * app's verified App Links domain (see `client/android/.../AndroidManifest.xml`
 * and `lib/deepLinkUrl.ts`): recipients WITH the app open it directly, and
 * recipients without it land on the hosted web client. Operators can override
 * at build time with `VITE_PUBLIC_WEB_ORIGIN`.
 */

import { Capacitor } from "@capacitor/core";

import { isDesktop } from "@/lib/desktop";

/** The hosted web client's origin, used as the base for native-built links. */
export const PUBLIC_WEB_ORIGIN: string =
  import.meta.env.VITE_PUBLIC_WEB_ORIGIN || "https://armada.buzz";

/**
 * The origin to build shareable links on: the page's own origin on the web,
 * the public deployment on native and desktop (where the runtime origin is the
 * shell's own local server or `app://` scheme, which nobody else can reach).
 */
export function shareOrigin(): string {
  if (Capacitor.isNativePlatform() || isDesktop()) return PUBLIC_WEB_ORIGIN;
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * A canonical, non-http sentinel to STORE a re-basable link on. It exists only
 * so `shareableInviteUrl` re-bases it onto whatever origin hands the link out;
 * it is never a real reachable origin.
 */
export const CANONICAL_LINK_BASE = "app://armada";

/**
 * The base to STORE a shareable link on, as opposed to the one to hand it out
 * on TODAY ({@link shareOrigin}).
 *
 * On the web this is the page's own origin: it is authoritative and — because
 * an http(s) origin is left untouched when re-based — it correctly follows the
 * link to the creator's other devices, so a self-hosted deployment's links
 * stay on that deployment everywhere.
 *
 * On native and desktop the runtime origin is unreachable (the WebView's local
 * server, the shell's `app://` scheme), so storing it would pin every reader to
 * a dead origin — and storing the concrete {@link PUBLIC_WEB_ORIGIN} fallback
 * would pin them all to armada.buzz even when the link is later handed out from
 * a self-hosted web client. A canonical sentinel is stored instead, and
 * re-based onto each reader's own share origin where the link is shown.
 */
export function linkStoreBase(): string {
  if (Capacitor.isNativePlatform() || isDesktop()) return CANONICAL_LINK_BASE;
  return typeof window !== "undefined" ? window.location.origin : CANONICAL_LINK_BASE;
}
