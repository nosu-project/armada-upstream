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

export interface LinuxShareAudioSource {
  id: string;
  name: string;
}

export interface LinuxShareAudioSources {
  supported: boolean;
  reason: string | null;
  sources: LinuxShareAudioSource[];
}

export type LinuxShareAudioSelection =
  | { mode: "system" }
  | { mode: "applications"; sourceIds: string[] };

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

/**
 * Which OS facility is encrypting stored secrets. On Linux this is Chromium's
 * selected password store; `basic_text` is a hardcoded key (obfuscation, not
 * encryption) and is what a machine with no keyring daemon gets.
 */
export interface SecretsStatus {
  available: boolean;
  backend:
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "darwin"
    | "win32"
    | "linux"
    | "unknown"
    | string;
}

/**
 * The desktop shell's ArmadaDB store: one SQLite file in the OS's per-app
 * config directory, with the query engine in the main process.
 *
 * `available` is resolved by the shell at preload time — the file is opened
 * before the window loads — so the renderer can decide which adapter to build
 * synchronously, and can fall back to IndexedDB when the shell couldn't open
 * it. `call` dispatches one `ArmadaDbPlugin` method; see `ElectronArmadaDB.ts`.
 */
interface ArmadaDesktopDb {
  available: boolean;
  call: (op: string, payload?: unknown) => Promise<unknown>;
}

export interface DesktopPushToTalkBinding {
  code: string;
  label: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface DesktopPushToTalkStatus {
  supported: boolean;
  backend: "native" | "portal" | null;
  bindingLabel: string | null;
  reason: string | null;
  settingsAvailable?: boolean;
  settingsHint?: string | null;
}

interface ArmadaDesktopBridge {
  isDesktop: true;
  setBadge: (count: number) => void;
  getInfo: () => Promise<{ platform: string; version: string }>;
  getScreenSources: () => Promise<ScreenSource[]>;
  onPickScreenSource: (handler: () => string | null | Promise<string | null>) => void;
  getLinuxShareAudioSources?: () => Promise<LinuxShareAudioSources>;
  startLinuxShareAudio?: (selection: LinuxShareAudioSelection) => Promise<boolean>;
  unmuteLinuxShareAudio?: () => Promise<boolean>;
  stopLinuxShareAudio?: () => Promise<void>;
  getMicAccessStatus: () => Promise<MicAccessStatus>;
  openMicPrivacySettings: () => Promise<boolean>;
  configurePushToTalk?: (
    binding: DesktopPushToTalkBinding | null,
  ) => Promise<DesktopPushToTalkStatus>;
  openPushToTalkSystemSettings?: () => Promise<boolean>;
  setPushToTalkActive?: (active: boolean) => Promise<boolean>;
  onPushToTalkState?: (handler: (pressed: boolean) => void) => () => void;
  onPushToTalkStatus?: (handler: (status: DesktopPushToTalkStatus) => void) => () => void;
  // Optional: a newer web bundle can run inside an older shell that predates
  // these, so every call site feature-detects rather than assuming.
  getSecretsStatus?: () => Promise<SecretsStatus>;
  encryptSecret?: (plaintext: string) => Promise<string | null>;
  decryptSecret?: (base64: string) => Promise<string | null>;
  armadaDb?: ArmadaDesktopDb;
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

/**
 * Whether the desktop shell can encrypt secrets with the OS credential store,
 * and which backend does it. Resolves `available: false` on the web and in
 * shells older than the bridge method.
 */
export async function desktopSecretsStatus(): Promise<SecretsStatus> {
  const bridge = desktop();
  if (!bridge?.getSecretsStatus) return { available: false, backend: "unknown" };
  try {
    return await bridge.getSecretsStatus();
  } catch {
    return { available: false, backend: "unknown" };
  }
}

/**
 * Encrypt a string with the OS credential store. Resolves null on the web, in
 * an older shell, or whenever encryption is unavailable — callers fall back to
 * storing plaintext rather than failing the write.
 */
export async function desktopEncryptSecret(plaintext: string): Promise<string | null> {
  const bridge = desktop();
  if (!bridge?.encryptSecret) return null;
  try {
    return await bridge.encryptSecret(plaintext);
  } catch {
    return null;
  }
}

/**
 * Decrypt base64 ciphertext from `desktopEncryptSecret`. Null means the blob
 * could not be opened — "locked", not "empty". Callers must preserve the
 * ciphertext rather than overwriting it.
 */
export async function desktopDecryptSecret(base64: string): Promise<string | null> {
  const bridge = desktop();
  if (!bridge?.decryptSecret) return null;
  try {
    return await bridge.decryptSecret(base64);
  } catch {
    return null;
  }
}

let nextLinuxShareAudioGeneration = 1;
let linuxShareAudioGeneration: number | null = null;
let displayMediaAudioInstalled = false;

/** List the applications PipeWire can route into a Linux screen share. */
export async function desktopShareAudioSources(): Promise<LinuxShareAudioSources> {
  const bridge = desktop();
  if (!bridge?.getLinuxShareAudioSources) {
    return { supported: false, reason: null, sources: [] };
  }
  try {
    return await bridge.getLinuxShareAudioSources();
  } catch {
    return { supported: false, reason: "Application audio could not be loaded.", sources: [] };
  }
}

/** Prepare the Linux virtual microphone selected in the screen-share dialog. */
export async function prepareDesktopShareAudio(
  selection: LinuxShareAudioSelection,
): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.startLinuxShareAudio) return false;
  try {
    const prepared = await bridge.startLinuxShareAudio(selection);
    linuxShareAudioGeneration = prepared ? nextLinuxShareAudioGeneration++ : null;
    return prepared;
  } catch {
    linuxShareAudioGeneration = null;
    return false;
  }
}

/** Tear down any PipeWire virtual microphone created for a share. */
export async function stopDesktopShareAudio(): Promise<void> {
  return stopDesktopShareAudioGeneration();
}

async function stopDesktopShareAudioGeneration(expected?: number): Promise<void> {
  if (expected !== undefined && linuxShareAudioGeneration !== expected) return;
  linuxShareAudioGeneration = null;
  try {
    await desktop()?.stopLinuxShareAudio?.();
  } catch {
    // Best effort: the shell also unlinks before starting the next share.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function findVenmicDevice(mediaDevices: MediaDevices): Promise<MediaDeviceInfo | null> {
  // PipeWire and Chromium discover the virtual source asynchronously. In the
  // common case it is present on the first pass; the short retry window keeps
  // slower graph updates from silently producing video-only shares.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const devices = await mediaDevices.enumerateDevices();
    const device = devices.find(
      (candidate) =>
        candidate.kind === "audioinput" && candidate.label === "vencord-screen-share",
    );
    if (device) return device;
    await wait(50);
  }
  return null;
}

/**
 * Add venmic's PipeWire audio track to Electron's Linux display stream.
 *
 * LiveKit calls navigator.mediaDevices.getDisplayMedia directly. Installing
 * this wrapper before React mounts lets the existing call path stay unchanged:
 * the screen picker prepares venmic, Electron returns video, and this function
 * attaches the virtual microphone before LiveKit sees the stream.
 */
export function installDesktopDisplayMediaAudio(): void {
  if (displayMediaAudioInstalled || typeof navigator === "undefined") return;
  const bridge = desktop();
  const mediaDevices = navigator.mediaDevices;
  if (
    !bridge?.startLinuxShareAudio ||
    !bridge.unmuteLinuxShareAudio ||
    !bridge.stopLinuxShareAudio ||
    typeof mediaDevices?.getDisplayMedia !== "function"
  ) {
    return;
  }
  const unmuteLinuxShareAudio = bridge.unmuteLinuxShareAudio;

  displayMediaAudioInstalled = true;
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    const generationBeforeCapture = linuxShareAudioGeneration;
    let stream: MediaStream;
    try {
      stream = await originalGetDisplayMedia(constraints);
    } catch (error) {
      // Cancelling a switch must leave the existing share's route alone. Only
      // tear down audio when the picker prepared a NEW route before failing.
      if (linuxShareAudioGeneration !== generationBeforeCapture) {
        await stopDesktopShareAudio();
      }
      throw error;
    }
    const captureGeneration = linuxShareAudioGeneration;
    if (captureGeneration === null) {
      return stream;
    }
    if (constraints?.audio === false || stream.getAudioTracks().length > 0) {
      await stopDesktopShareAudioGeneration(captureGeneration);
      return stream;
    }

    try {
      const device = await findVenmicDevice(mediaDevices);
      if (!device) throw new Error("venmic virtual microphone did not appear");
      const audioStream = await mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: device.deviceId },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: 2,
          sampleRate: 48_000,
        },
      });
      const audioTrack = audioStream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("venmic returned no audio track");
      stream.addTrack(audioTrack);
      await unmuteLinuxShareAudio();

      let stopped = false;
      const stopAudio = () => {
        if (stopped) return;
        stopped = true;
        audioTrack.stop();
        void stopDesktopShareAudioGeneration(captureGeneration);
      };
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener("ended", stopAudio, { once: true });
        // MediaStreamTrack.stop() does not dispatch `ended`, and LiveKit uses
        // stop() when the user unpublishes. Wrap it so PipeWire still unlinks.
        const stopVideo = videoTrack.stop.bind(videoTrack);
        videoTrack.stop = () => {
          stopAudio();
          stopVideo();
        };
      }
      audioTrack.addEventListener(
        "ended",
        () => void stopDesktopShareAudioGeneration(captureGeneration),
        { once: true },
      );
      return stream;
    } catch (error) {
      console.warn("[screen-share] failed to attach Linux application audio", error);
      await stopDesktopShareAudio();
      return stream;
    }
  };
}
