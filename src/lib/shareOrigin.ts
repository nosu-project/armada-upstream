/**
 * The origin shareable links are built on (#44). Capacitor (`https://localhost`)
 * and Electron (`app://armada`) origins are unreachable to recipients, so those
 * builds use the public web deployment, which is also the verified App Links
 * domain. Override with `PUBLIC_WEB_ORIGIN`.
 */

import { Capacitor } from "@capacitor/core";

import { isDesktop } from "@/lib/desktop";
import { config } from "@/lib/env";

/** The hosted web client's origin, used as the base for native-built links. */
export const PUBLIC_WEB_ORIGIN: string =
  config("PUBLIC_WEB_ORIGIN") || "https://armada.buzz";

/** Page origin on the web; the public deployment on native and desktop. */
export function shareOrigin(): string {
  if (Capacitor.isNativePlatform() || isDesktop()) return PUBLIC_WEB_ORIGIN;
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** Non-http sentinel for STORED links; `shareableInviteUrl` re-bases it and it is never reachable. */
export const CANONICAL_LINK_BASE = "app://armada";

/**
 * The base to STORE a shareable link on (vs {@link shareOrigin} for handing
 * out). Web stores its own origin, which re-basing leaves untouched, so
 * self-hosted links stay put. Native/desktop store {@link CANONICAL_LINK_BASE}
 * so each reader re-bases onto its own share origin.
 */
export function linkStoreBase(): string {
  if (Capacitor.isNativePlatform() || isDesktop()) return CANONICAL_LINK_BASE;
  return typeof window !== "undefined" ? window.location.origin : CANONICAL_LINK_BASE;
}
