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

export type DesktopVideoEncoderMode = "compatibility" | "hardware";

export interface DesktopVideoEncoderState {
  available: boolean;
  active: DesktopVideoEncoderMode | null;
  configured: DesktopVideoEncoderMode | null;
  restartRequired?: boolean;
}

export interface DesktopHevcScreenShareCapability {
  available: boolean;
  encoder: string | null;
  backend: string | null;
  device: string | null;
  helperPath?: string | null;
  ffmpegPath?: string | null;
  reason: string | null;
}

export type DesktopHevcScreenShareState =
  | "idle"
  | "starting"
  | "published"
  | "error"
  | "stopped";

/** Live state emitted by the Linux FFmpeg/VA-API screen-share publisher. */
export interface DesktopHevcScreenShareStatus {
  state: DesktopHevcScreenShareState;
  active: boolean;
  sessionId?: string;
  backend?: string;
  encoder?: string;
  device?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  framesReceived?: number;
  framesDropped?: number;
  inputFrameRate?: number;
  encodedBytes?: number;
  encodedBitrate?: number;
  pipelineStage?: string;
  error?: string;
  reason?: string;
}

export interface DesktopHevcScreenShareConfig {
  url: string;
  token: string;
  /** Exactly 32 sender-key bytes, base64 encoded. */
  keyMaterial: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
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
  getVideoEncoderMode?: () => Promise<DesktopVideoEncoderState>;
  setVideoEncoderMode?: (mode: DesktopVideoEncoderMode) => Promise<DesktopVideoEncoderState>;
  getHevcScreenShareCapability?: () => Promise<DesktopHevcScreenShareCapability>;
  getHevcScreenShareStatus?: () => Promise<DesktopHevcScreenShareStatus>;
  startHevcScreenShare?: (
    config: DesktopHevcScreenShareConfig,
  ) => Promise<DesktopHevcScreenShareStatus>;
  stopHevcScreenShare?: () => Promise<DesktopHevcScreenShareStatus>;
  onHevcScreenShareStatus?: (
    handler: (status: DesktopHevcScreenShareStatus) => void,
  ) => () => void;
  getScreenSources: () => Promise<ScreenSource[]>;
  onPickScreenSource: (handler: () => string | null | Promise<string | null>) => void;
  getLinuxShareAudioSources?: () => Promise<LinuxShareAudioSources>;
  startLinuxShareAudio?: (selection: LinuxShareAudioSelection) => Promise<boolean>;
  unmuteLinuxShareAudio?: () => Promise<boolean>;
  stopLinuxShareAudio?: () => Promise<void>;
  getMicAccessStatus: () => Promise<MicAccessStatus>;
  openMicPrivacySettings: () => Promise<boolean>;
  getScreenCaptureAccessStatus?: () => Promise<MicAccessStatus>;
  openScreenCapturePrivacySettings?: () => Promise<boolean>;
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
  signalWebReady?: () => void;
  // Optional for the same reason: a copied message/invite link clicked inside
  // an OLDER shell has no interception path and simply opens in the browser as
  // it did before. The renderer reports its App Links host at boot, and the
  // shell hands back the router path of a link to that host it caught.
  registerDeepLinkHost?: (host: string) => void;
  onDeepLink?: (handler: (path: string) => void) => () => void;
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

// An IPC handler that throws rejects the renderer's promise, so — like every
// other bridge wrapper here — an unreachable or failing shell reads as "no
// answer" rather than propagating into whatever rendered the control.
export async function getDesktopVideoEncoderState(): Promise<DesktopVideoEncoderState | null> {
  try {
    return (await desktop()?.getVideoEncoderMode?.()) ?? null;
  } catch (error) {
    console.warn("failed to read the desktop video encoder mode", error);
    return null;
  }
}

export async function setDesktopVideoEncoderMode(
  mode: DesktopVideoEncoderMode,
): Promise<DesktopVideoEncoderState | null> {
  try {
    return (await desktop()?.setVideoEncoderMode?.(mode)) ?? null;
  } catch (error) {
    console.warn("failed to set the desktop video encoder mode", error);
    return null;
  }
}

/** Probe the custom Linux FFmpeg/VA-API H.265 path. */
export async function desktopHevcScreenShareCapability(): Promise<DesktopHevcScreenShareCapability> {
  const bridge = desktop();
  if (!bridge?.getHevcScreenShareCapability) {
    return {
      available: false,
      encoder: null,
      backend: null,
      device: null,
      reason: "This Armada build does not contain the custom H.265 publisher.",
    };
  }
  try {
    return await bridge.getHevcScreenShareCapability();
  } catch (error) {
    return {
      available: false,
      encoder: null,
      backend: null,
      device: null,
      reason: error instanceof Error ? error.message : "The H.265 capability probe failed.",
    };
  }
}

export function subscribeDesktopHevcScreenShareStatus(
  handler: (status: DesktopHevcScreenShareStatus) => void,
): () => void {
  return desktop()?.onHevcScreenShareStatus?.(handler) ?? (() => {});
}

let hevcFrameAbort: AbortController | null = null;
let hevcFramePort: MessagePort | null = null;
let hevcFrameGeneration = 0;
const pendingHevcPorts = new Map<string, MessagePort>();
const waitingHevcPorts = new Map<string, (port: MessagePort) => void>();

/** Accept the frame channel transferred by preload for one exact shell session. */
export function acceptDesktopHevcScreenShareFramePort(
  sessionId: string,
  port: MessagePort,
): void {
  port.start();
  const resolve = waitingHevcPorts.get(sessionId);
  if (resolve) {
    waitingHevcPorts.delete(sessionId);
    resolve(port);
    return;
  }
  try {
    pendingHevcPorts.get(sessionId)?.close();
  } catch {
    // already closed
  }
  pendingHevcPorts.set(sessionId, port);
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.type !== "armada:hevc-screen-share-port" ||
      typeof event.data.sessionId !== "string" ||
      !event.ports[0]
    ) {
      return;
    }
    acceptDesktopHevcScreenShareFramePort(event.data.sessionId, event.ports[0]);
  });
}

function waitForHevcFramePort(sessionId: string, signal: AbortSignal): Promise<MessagePort> {
  const pending = pendingHevcPorts.get(sessionId);
  if (pending) {
    pendingHevcPorts.delete(sessionId);
    if (signal.aborted) {
      try {
        pending.close();
      } catch {
        // already closed
      }
      return Promise.reject(new Error("The H.265 start was cancelled."));
    }
    return Promise.resolve(pending);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (port?: MessagePort, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      waitingHevcPorts.delete(sessionId);
      if (error) reject(error);
      else if (port) resolve(port);
    };
    const onPort = (port: MessagePort) => finish(port);
    const onAbort = () => finish(undefined, new Error("The H.265 start was cancelled."));
    const timeout = window.setTimeout(
      () => finish(undefined, new Error("The H.265 frame channel did not open.")),
      5_000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    waitingHevcPorts.set(sessionId, onPort);
    if (signal.aborted) onAbort();
  });
}

function disposeHevcPreview(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    // already detached
  }
  video.srcObject = null;
  video.remove();
}

function cancelHevcFramePump(): void {
  hevcFrameGeneration += 1;
  hevcFrameAbort?.abort();
  hevcFrameAbort = null;
}

function closeHevcFramePorts(): void {
  try {
    hevcFramePort?.close();
  } catch {
    // already closed
  }
  hevcFramePort = null;
  for (const port of pendingHevcPorts.values()) {
    try {
      port.close();
    } catch {
      // already closed
    }
  }
  pendingHevcPorts.clear();
  waitingHevcPorts.clear();
}

/** Stop renderer conversion without asking the shell to stop again. */
export function cancelDesktopHevcScreenShareFrames(): void {
  cancelHevcFramePump();
  closeHevcFramePorts();
}

function waitForVideoFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let frameCallback = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeEventListener("error", onError);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("resize", onReady);
      track.removeEventListener("ended", onEnded);
      signal.removeEventListener("abort", onAbort);
      if (frameCallback && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameCallback);
      }
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(new Error(video.error?.message || "Chromium rejected the captured video track."));
    const onReady = () => {
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        finish();
      }
    };
    const onEnded = () => finish(new Error("The selected screen source ended before capture began."));
    const onAbort = () => finish(new Error("The H.265 start was cancelled."));
    const timeout = window.setTimeout(() => {
      const settings = track.getSettings();
      finish(new Error(
        `No captured video frame became available within 15 seconds (track=${track.readyState}, muted=${track.muted}, track-size=${settings.width ?? "?"}×${settings.height ?? "?"}, video=${video.videoWidth}×${video.videoHeight}, readyState=${video.readyState}).`,
      ));
    }, 15_000);

    video.addEventListener("error", onError, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("playing", onReady, { once: true });
    video.addEventListener("resize", onReady);
    track.addEventListener("ended", onEnded, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (typeof video.requestVideoFrameCallback === "function") {
      frameCallback = video.requestVideoFrameCallback(() => finish());
    }
    video.play().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    if (track.readyState !== "live") onEnded();
    onReady();
    if (signal.aborted) onAbort();
  });
}

async function copyHevcFrame(
  video: HTMLVideoElement,
  canvas: OffscreenCanvas,
  context: OffscreenCanvasRenderingContext2D,
  output: ArrayBuffer,
  config: Pick<DesktopHevcScreenShareConfig, "width" | "height">,
  signal: AbortSignal,
): Promise<void> {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    throw new Error("Chromium reported no current captured video frame.");
  }

  const source = new VideoFrame(video, { timestamp: Math.round(performance.now() * 1_000) });
  try {
    const sourceWidth = source.displayWidth || source.codedWidth;
    const sourceHeight = source.displayHeight || source.codedHeight;
    const scale = Math.min(config.width / sourceWidth, config.height / sourceHeight);
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
    const left = Math.floor((config.width - width) / 2);
    const top = Math.floor((config.height - height) / 2);
    const resize = sourceWidth !== config.width || sourceHeight !== config.height;
    let frame = source;
    let ownsFrame = false;
    if (resize) {
      context.fillStyle = "black";
      context.fillRect(0, 0, config.width, config.height);
      context.drawImage(source, left, top, width, height);
      frame = new VideoFrame(canvas, {
        timestamp: source.timestamp,
        ...(source.duration === null ? {} : { duration: source.duration }),
      });
      ownsFrame = true;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(new Error("The H.265 frame conversion was cancelled."));
        const timeout = window.setTimeout(
          () => finish(new Error("Chromium did not convert the captured frame within 10 seconds.")),
          10_000,
        );
        signal.addEventListener("abort", onAbort, { once: true });
        frame.copyTo(output, {
          format: "RGBA",
          layout: [{ offset: 0, stride: config.width * 4 }],
        }).then(() => finish(), (error) => finish(error instanceof Error ? error : new Error(String(error))));
        if (signal.aborted) onAbort();
      });
    } finally {
      if (ownsFrame) frame.close();
    }
  } finally {
    source.close();
  }
}

function postHevcFrame(
  port: MessagePort,
  frame: ArrayBuffer,
  sequence: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (accepted: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      port.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(accepted);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "frame-ack" && event.data.sequence === sequence) finish(true);
    };
    const onAbort = () => finish(false);
    const timeout = window.setTimeout(
      () => finish(false, new Error("FFmpeg did not accept a capture frame within 10 seconds.")),
      10_000,
    );
    port.addEventListener("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      // Electron 43 cannot reliably transfer this ArrayBuffer through its
      // main-process MessagePort. Keep one reusable cloned buffer in flight.
      port.postMessage({ type: "frame", sequence, frame });
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Convert the trusted Chromium capture to bounded RGBA frames and feed the
 * Linux FFmpeg/VA-API publisher. Resolves only after real HEVC bytes have been
 * published, so an empty signaling track is never reported as success.
 */
export async function startDesktopHevcScreenShare(
  track: MediaStreamTrack,
  config: DesktopHevcScreenShareConfig,
): Promise<DesktopHevcScreenShareStatus> {
  const bridge = desktop();
  if (!bridge?.startHevcScreenShare || !bridge.stopHevcScreenShare) {
    throw new Error("This Armada shell does not contain the custom H.265 publisher.");
  }
  if (
    typeof document === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    throw new Error("This desktop runtime cannot convert captured frames for H.265.");
  }

  const controller = new AbortController();
  const generation = ++hevcFrameGeneration;
  hevcFrameAbort?.abort();
  hevcFrameAbort = controller;
  await bridge.stopHevcScreenShare();
  closeHevcFramePorts();
  if (controller.signal.aborted || generation !== hevcFrameGeneration) {
    throw new Error("The H.265 start was cancelled.");
  }
  if (track.readyState !== "live") {
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    throw new Error("The selected screen source ended before capture began.");
  }
  track.contentHint = "detail";

  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:2px",
    "height:2px",
    "opacity:0.001",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);

  const canvas = new OffscreenCanvas(config.width, config.height);
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) {
    disposeHevcPreview(video);
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    throw new Error("Could not create the H.265 frame conversion canvas.");
  }
  const frameInterval = 1_000 / config.frameRate;
  const frame = new ArrayBuffer(config.width * config.height * 4);
  let shellStarted = false;
  let port: MessagePort | null = null;

  try {
    await waitForVideoFrame(video, track, controller.signal);
    await copyHevcFrame(video, canvas, context, frame, config, controller.signal);
    if (controller.signal.aborted || generation !== hevcFrameGeneration) {
      throw new Error("The H.265 start was cancelled.");
    }
    const started = await bridge.startHevcScreenShare(config);
    shellStarted = true;
    if (controller.signal.aborted || generation !== hevcFrameGeneration) {
      throw new Error("The H.265 start was superseded.");
    }
    if (!started.sessionId) {
      throw new Error("The H.265 encoder did not identify its frame channel.");
    }
    port = await waitForHevcFramePort(started.sessionId, controller.signal);
    hevcFramePort = port;
    port.postMessage({ type: "stage", stage: "Sending verified capture frame" });

    let sequence = 0;
    if (!await postHevcFrame(port, frame, ++sequence, controller.signal)) {
      throw new Error("The H.265 start was cancelled before its first frame was accepted.");
    }

    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const began = performance.now();
          if (
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.videoWidth === 0 ||
            video.videoHeight === 0
          ) {
            await new Promise((resolve) => window.setTimeout(resolve, 10));
            continue;
          }
          await copyHevcFrame(video, canvas, context, frame, config, controller.signal);
          if (!await postHevcFrame(port!, frame, ++sequence, controller.signal)) break;
          const remaining = frameInterval - (performance.now() - began);
          if (remaining > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remaining));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[screen-share] H.265 frame conversion stopped", error);
          // postMessage on a closed or disentangled port is a silent no-op
          // rather than a throw, so the shell is asked to stop unconditionally
          // instead of only from a catch that would never run.
          try {
            port?.postMessage({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The stop below is the recovery either way.
          }
          void bridge.stopHevcScreenShare?.().catch((stopError) =>
            console.warn("[screen-share] failed to stop the H.265 publisher", stopError),
          );
        }
      } finally {
        disposeHevcPreview(video);
        if (hevcFrameAbort === controller) hevcFrameAbort = null;
        // The pump can end on its own (a conversion or acknowledgement
        // timeout), and a later stop only closes the port it still knows
        // about — so clearing the reference without closing strands it.
        if (hevcFramePort === port) {
          try {
            port?.close();
          } catch {
            // already closed
          }
          hevcFramePort = null;
        }
      }
    })();

    if (!bridge.getHevcScreenShareStatus) return started;
    const deadline = performance.now() + 20_000;
    while (!controller.signal.aborted && performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const status = await bridge.getHevcScreenShareStatus();
      if (status.state === "published" && (status.encodedBytes ?? 0) > 0) return status;
      if (status.state === "error") {
        throw new Error(status.error || "The H.265 pipeline failed before sending video.");
      }
    }
    if (controller.signal.aborted) {
      const status = await bridge.getHevcScreenShareStatus();
      throw new Error(status.error || status.reason || "The H.265 start was cancelled.");
    }
    throw new Error("The H.265 pipeline did not produce video within 20 seconds.");
  } catch (error) {
    controller.abort();
    try {
      port?.close();
    } catch {
      // already closed
    }
    if (hevcFramePort === port) hevcFramePort = null;
    disposeHevcPreview(video);
    if (shellStarted && generation === hevcFrameGeneration) {
      try {
        await bridge.stopHevcScreenShare();
      } catch {
        // Preserve the more useful pipeline failure.
      }
    }
    if (hevcFrameAbort === controller) hevcFrameAbort = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start the H.265 capture pipeline: ${detail}`);
  }
}

export async function stopDesktopHevcScreenShare(): Promise<DesktopHevcScreenShareStatus> {
  cancelHevcFramePump();
  const bridge = desktop();
  if (!bridge?.stopHevcScreenShare) {
    closeHevcFramePorts();
    return { state: "idle", active: false };
  }
  try {
    return await bridge.stopHevcScreenShare();
  } finally {
    closeHevcFramePorts();
  }
}

/**
 * Tell the desktop shell this web bundle painted.
 *
 * The shell serves a swappable bundle out of userData, and silence past its
 * grace period is how it learns the bundle it chose does not come up — which
 * makes it look for a newer one immediately instead of waiting for the next
 * scheduled check. Recovery is forward-only, so this signal is the difference
 * between minutes and hours of a broken client.
 */
export function signalDesktopWebReady(): void {
  try {
    desktop()?.signalWebReady?.();
  } catch {
    // An older shell, or a bridge torn down mid-shutdown. The shell's grace
    // period simply expires; never let this break first paint.
  }
}

/**
 * Tell the desktop shell which host our shareable links are built on, so it can
 * catch a link to that host clicked inside the app (a copied message or invite
 * link) and route it through the router instead of the system browser. No-op on
 * the web and in a shell older than the bridge method.
 */
export function registerDesktopDeepLinkHost(host: string): void {
  try {
    desktop()?.registerDeepLinkHost?.(host);
  } catch {
    // An older shell without the interception path; the link opens in the
    // browser as before. Never let this break boot.
  }
}

/**
 * Subscribe to in-app deep links the desktop shell intercepted. The handler
 * receives the router path. Returns an unsubscribe; a no-op on the web or in an
 * older shell.
 */
export function onDesktopDeepLink(handler: (path: string) => void): () => void {
  try {
    return desktop()?.onDeepLink?.(handler) ?? (() => {});
  } catch {
    return () => {};
  }
}

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

/** macOS Screen Recording privacy status; unknown elsewhere. */
export async function desktopScreenCaptureAccessStatus(): Promise<MicAccessStatus> {
  const bridge = desktop();
  if (!bridge?.getScreenCaptureAccessStatus) return "unknown";
  try {
    return await bridge.getScreenCaptureAccessStatus();
  } catch {
    return "unknown";
  }
}

/** Open macOS Privacy & Security at Screen Recording. */
export async function openDesktopScreenCaptureSettings(): Promise<boolean> {
  const bridge = desktop();
  if (!bridge?.openScreenCapturePrivacySettings) return false;
  try {
    return await bridge.openScreenCapturePrivacySettings();
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
// Set when the picker chose "No audio"; consumed by the next capture.
let shareAudioDeclined = false;
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
    shareAudioDeclined = false;
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

/**
 * Record that the next capture is to carry no share audio.
 *
 * The teardown is deferred to that capture rather than done here, because the
 * picker may still be cancelled. Unlinking at selection time silences the share
 * the user currently has published and leaves nothing to restore it — the same
 * acquire-before-replace rule the rest of this module follows.
 */
export function declineDesktopShareAudio(): void {
  shareAudioDeclined = true;
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
    if (shareAudioDeclined) {
      // The capture succeeded, so the share this route belonged to is gone.
      shareAudioDeclined = false;
      await stopDesktopShareAudio();
      return stream;
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
      // Scope the teardown like every other one here: findVenmicDevice retries
      // for about a second and getUserMedia can stall, which is long enough for
      // a newer share to have prepared its own route.
      await stopDesktopShareAudioGeneration(captureGeneration);
      return stream;
    }
  };
}
