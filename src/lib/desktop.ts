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

/**
 * OS-level microphone access status, independent of the in-app permission
 * handler. "granted" always on Linux; reflects the system privacy setting on
 * macOS (TCC) and Windows ("let desktop apps use the microphone").
 */
export type MicAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

interface ArmadaDesktopBridge {
  isDesktop: true;
  setBadge: (count: number) => void;
  getInfo: () => Promise<{ platform: string; version: string }>;
  getScreenSources: () => Promise<ScreenSource[]>;
  onPickScreenSource: (handler: () => string | null | Promise<string | null>) => void;
  getMicAccessStatus: () => Promise<MicAccessStatus>;
  openMicPrivacySettings: () => Promise<boolean>;
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

/**
 * OS-level microphone access status in the desktop app. Resolves "granted" on
 * the web (where the browser/OS handles the prompt) and whenever the bridge is
 * unavailable, so callers can treat anything other than "denied"/"restricted"
 * as "try getUserMedia and let the browser prompt".
 */
export async function desktopMicAccessStatus(): Promise<MicAccessStatus> {
  const bridge = desktop();
  if (!bridge?.getMicAccessStatus) return "granted";
  try {
    return await bridge.getMicAccessStatus();
  } catch {
    return "unknown";
  }
}

/**
 * Open the OS microphone privacy settings (Windows/macOS). Returns true if a
 * settings page was opened, false on web or unsupported platforms.
 */
export async function openDesktopMicSettings(): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.openMicPrivacySettings) return false;
  try {
    return await bridge.openMicPrivacySettings();
  } catch {
    return false;
  }
}
