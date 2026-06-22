/**
 * Desktop (Electron) bridge.
 *
 * The Armada desktop shell injects `window.armadaDesktop` (see
 * client/electron/preload.js). On the web this is absent and every helper here
 * no-ops, so call sites don't need platform branches.
 */

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string;
  isScreen: boolean;
}

interface ArmadaDesktopBridge {
  isDesktop: true;
  setBadge: (count: number) => void;
  getInfo: () => Promise<{ platform: string; version: string }>;
  getScreenSources: () => Promise<ScreenSource[]>;
  onPickScreenSource: (handler: () => string | null | Promise<string | null>) => void;
}

declare global {
  interface Window {
    armadaDesktop?: ArmadaDesktopBridge;
  }
}

/** The desktop bridge, or undefined on the web. */
export function desktop(): ArmadaDesktopBridge | undefined {
  return typeof window !== "undefined" ? window.armadaDesktop : undefined;
}

/** True when running inside the Armada desktop app. */
export const isDesktop = (): boolean => Boolean(desktop()?.isDesktop);

/** Reflect the unread count on the tray / OS badge (no-op on web). */
export function setDesktopBadge(count: number): void {
  try {
    desktop()?.setBadge(count);
  } catch {
    // ignore
  }
}
