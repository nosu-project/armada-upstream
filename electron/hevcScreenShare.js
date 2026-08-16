// Linux desktop H.265 screen-share process controller.
//
// Chromium's Linux WebRTC sender does not advertise H.265, even when the Mesa
// VA-API driver can encode it. The renderer still owns the trusted display
// picker; RGBA frames cross a MessagePort into this controller, FFmpeg encodes
// them with hevc_vaapi, and the Go helper publishes the Annex-B stream through
// LiveKit with Concord-compatible frame encryption.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HELPER_NAME = "armada-hevc-publisher";
// Retained as a compatibility fallback for Flatpaks built before the publisher
// moved into Electron's resources directory. New Linux packages use the same
// process.resourcesPath location in AppImage, deb, and Flatpak.
const HELPER_PATH = "/app/bin/armada-hevc-publisher";
const FFMPEG_PATH = "/usr/bin/ffmpeg";
const HOST_FFMPEG_PATHS = [
  FFMPEG_PATH,
  "/usr/local/bin/ffmpeg",
  "/run/current-system/sw/bin/ffmpeg",
];
const MIN_BITRATE = 250_000;
const MAX_BITRATE = 25_000_000;
const MAX_CONFIG_BYTES = 64 * 1024;
/** Cap on an unterminated publisher status line held between stderr chunks. */
const MAX_STATUS_CARRY_BYTES = 64 * 1024;
/** How long a child gets to act on SIGTERM before SIGKILL. */
const KILL_ESCALATION_MS = 5_000;
const MAX_RENDER_NODES = 4;
// Some otherwise capable VA-API HEVC drivers reject 128px-wide inputs. Use a
// small, conventional 16:9 frame that exercises the same upload/encode path
// without falling below those hardware minimums.
const PROBE_WIDTH = 320;
const PROBE_HEIGHT = 180;
const PROBE_FRAMES = 2;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_MAX_BUFFER = 2 * 1024 * 1024;
const CAPABILITY_SUCCESS_TTL_MS = 5 * 60_000;
const CAPABILITY_FAILURE_TTL_MS = 5_000;
const PROBE_CONFIG = {
  width: PROBE_WIDTH,
  height: PROBE_HEIGHT,
  frameRate: 30,
  bitrate: 1_000_000,
};
const PROBE_INPUT = Buffer.alloc(PROBE_WIDTH * PROBE_HEIGHT * 4 * PROBE_FRAMES, 0x40);

function unavailable(reason, { helperPath = null, ffmpegPath = null } = {}) {
  return {
    available: false,
    encoder: null,
    backend: null,
    device: null,
    helperPath,
    ffmpegPath,
    reason,
  };
}

function isWithin(candidate, parent) {
  if (!candidate || !parent || !path.isAbsolute(candidate) || !path.isAbsolute(parent)) {
    return false;
  }
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/**
 * AppImage's AppRun prepends libraries from its mount to LD_LIBRARY_PATH.
 * Those libraries are for Electron, not an arbitrary host FFmpeg process. A
 * host binary inheriting them can fail before main() with an ABI mismatch.
 */
function ffmpegChildEnvironment(env = process.env) {
  const child = { ...env };
  if (env.FLATPAK_ID || !env.APPIMAGE || !path.isAbsolute(env.APPDIR || "")) {
    return child;
  }
  for (const name of ["PATH", "LD_LIBRARY_PATH"]) {
    if (typeof env[name] !== "string") continue;
    const entries = env[name]
      .split(path.delimiter)
      // Empty/relative entries resolve through the current directory and are
      // inappropriate when locating or loading a privileged media binary.
      .filter((entry) => path.isAbsolute(entry) && !isWithin(entry, env.APPDIR));
    if (entries.length > 0) child[name] = entries.join(path.delimiter);
    else delete child[name];
  }
  return child;
}

function isExecutable(filePath, fsImpl = fs) {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    const stat = fsImpl.statSync?.(filePath, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return false;
    if (!stat && fsImpl.existsSync && !fsImpl.existsSync(filePath)) return false;
    fsImpl.accessSync?.(filePath, fs.constants.X_OK);
    return Boolean(stat || fsImpl.existsSync?.(filePath));
  } catch {
    return false;
  }
}

function isAccessibleDevice(filePath, fsImpl = fs) {
  try {
    if (fsImpl.existsSync && !fsImpl.existsSync(filePath)) return false;
    fsImpl.accessSync?.(filePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function renderNodes(fsImpl = fs) {
  try {
    return fsImpl
      .readdirSync("/dev/dri")
      .filter((name) => /^renderD\d+$/.test(name))
      .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)))
      .slice(0, MAX_RENDER_NODES)
      .map((name) => path.posix.join("/dev/dri", name));
  } catch {
    return [];
  }
}

function resolveHelperPath({ env = process.env, resourcesPath = process.resourcesPath, fsImpl = fs } = {}) {
  const bundled = resourcesPath ? path.resolve(resourcesPath, HELPER_NAME) : null;
  if (bundled && isExecutable(bundled, fsImpl)) return bundled;
  if (env.FLATPAK_ID && isExecutable(HELPER_PATH, fsImpl)) return HELPER_PATH;
  return null;
}

function resolveFfmpegPath({ env = process.env, fsImpl = fs } = {}) {
  if (env.FLATPAK_ID) return isExecutable(FFMPEG_PATH, fsImpl) ? FFMPEG_PATH : null;

  const childEnv = ffmpegChildEnvironment(env);
  const candidates = [];
  if (path.isAbsolute(env.ARMADA_FFMPEG_PATH || "")) candidates.push(env.ARMADA_FFMPEG_PATH);
  candidates.push(...HOST_FFMPEG_PATHS);
  for (const directory of (childEnv.PATH || "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, "ffmpeg"));
  }
  for (const candidate of new Set(candidates)) {
    if (isExecutable(candidate, fsImpl)) return candidate;
  }
  return null;
}

function ffmpegProbeArgs(device) {
  const args = ffmpegArgs(PROBE_CONFIG, device);
  args[args.indexOf("warning")] = "error";
  args.splice(args.length - 3, 0, "-frames:v", String(PROBE_FRAMES));
  return args;
}

function outputLength(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return value.length ?? value.byteLength;
  }
  return value instanceof ArrayBuffer ? value.byteLength : 0;
}

/** Run the bounded FFmpeg probe without blocking Electron's main event loop. */
function runFfmpegProbe(
  ffmpegPath,
  args,
  {
    env,
    input = PROBE_INPUT,
    timeout = PROBE_TIMEOUT_MS,
    maxBuffer = PROBE_MAX_BUFFER,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(ffmpegPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error });
      return;
    }

    let settled = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    let stderr = "";
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited while an output/timeout handler ran.
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: stdoutLength, stderr });
    };
    const failForBuffer = () => {
      if (settled) return;
      const error = Object.assign(new Error("FFmpeg probe output exceeded its safety limit"), {
        code: "ENOBUFS",
      });
      kill();
      finish({ error });
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`FFmpeg probe timed out after ${timeout} ms`), {
        code: "ETIMEDOUT",
      });
      kill();
      finish({ error });
    }, timeout);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdoutLength += outputLength(chunk);
      if (stdoutLength + stderrLength > maxBuffer) failForBuffer();
    });
    child.stderr?.on("data", (chunk) => {
      stderrLength += outputLength(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-maxBuffer);
      if (stdoutLength + stderrLength > maxBuffer) failForBuffer();
    });
    child.once("error", (error) => finish({ error }));
    child.once("close", (status, signal) => finish({ status, signal }));
    // FFmpeg can close stdin early when a driver rejects the profile. Its
    // close event and stderr carry the useful diagnosis, so do not replace
    // them with an unhandled EPIPE.
    child.stdin?.on("error", () => {});
    try {
      child.stdin.end(input);
    } catch (error) {
      kill();
      finish({ error });
    }
  });
}

function probeFailure(result) {
  if (result?.error) {
    if (result.error.code === "ETIMEDOUT") return `probe timed out after ${PROBE_TIMEOUT_MS} ms`;
    return String(result.error.message || result.error.code || "could not start FFmpeg");
  }
  const stderr = String(result?.stderr || "").replace(/[\r\n\t ]+/g, " ").trim();
  if (stderr) return stderr.slice(-800);
  if (result?.status === 0) return "FFmpeg produced no HEVC output";
  return `FFmpeg exited with code ${result?.status ?? "unknown"}`;
}

/** Probe the exact helper, FFmpeg arguments, driver, and device the stream uses. */
async function detectHevcCapability({
  env = process.env,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fsImpl = fs,
  spawnImpl = spawn,
  probeImpl = runFfmpegProbe,
} = {}) {
  if (platform !== "linux") {
    return unavailable("The custom FFmpeg/VA-API H.265 encoder is available only on Linux.");
  }
  const helperPath = resolveHelperPath({ env, resourcesPath, fsImpl });
  if (!helperPath) {
    return unavailable("This Armada Linux package is missing an executable H.265 publisher.");
  }
  const ffmpegPath = resolveFfmpegPath({ env, fsImpl });
  if (!ffmpegPath) {
    return unavailable(
      env.FLATPAK_ID
        ? "The Flatpak runtime does not contain FFmpeg."
        : "No host FFmpeg executable was found. Install FFmpeg with the hevc_vaapi encoder.",
      { helperPath },
    );
  }
  const nodes = renderNodes(fsImpl);
  if (nodes.length === 0) {
    return unavailable("No VA-API render device is available at /dev/dri.", {
      helperPath,
      ffmpegPath,
    });
  }
  const accessible = nodes.filter((device) => isAccessibleDevice(device, fsImpl));
  if (accessible.length === 0) {
    return unavailable("Armada cannot read and write any VA-API render device under /dev/dri.", {
      helperPath,
      ffmpegPath,
    });
  }

  const childEnv = ffmpegChildEnvironment(env);
  const failures = [];
  for (const device of accessible) {
    let result;
    try {
      result = await probeImpl(ffmpegPath, ffmpegProbeArgs(device), {
        env: childEnv,
        input: PROBE_INPUT,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        windowsHide: true,
        spawnImpl,
      });
    } catch (error) {
      result = { error };
    }
    if (!result?.error && result?.status === 0 && outputLength(result.stdout) > 0) {
      return {
        available: true,
        encoder: "HEVC Main",
        backend: "FFmpeg hevc_vaapi",
        device,
        helperPath,
        ffmpegPath,
        reason: null,
      };
    }
    failures.push(`${device}: ${probeFailure(result)}`);
  }
  return unavailable(
    `FFmpeg could not encode H.265 with VA-API. ${failures.join("; ")}`,
    { helperPath, ffmpegPath },
  );
}

/**
 * Share one non-blocking probe across the settings dialog and a subsequent
 * start. Successful hardware detection is stable for the process; failures
 * get a short TTL so installing FFmpeg or fixing device permissions can heal
 * without restarting Armada. Concurrent callers always join the same probe.
 */
function createHevcCapabilityDetector({
  detect = () => detectHevcCapability(),
  now = () => Date.now(),
  successTtlMs = CAPABILITY_SUCCESS_TTL_MS,
  failureTtlMs = CAPABILITY_FAILURE_TTL_MS,
} = {}) {
  let cached = null;
  let inFlight = null;

  return ({ force = false } = {}) => {
    const timestamp = now();
    if (!force && cached && timestamp < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    if (inFlight) return inFlight;

    let request;
    request = Promise.resolve()
      .then(() => detect())
      .then((value) => {
        cached = {
          value,
          expiresAt: now() + (value?.available ? successTtlMs : failureTtlMs),
        };
        return value;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  };
}

const detectCachedHevcCapability = createHevcCapabilityDetector();

function decodeMaterial(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const decoded = Buffer.from(value, "base64");
  // Buffer.from is deliberately forgiving, so round-trip the significant
  // base64 characters before treating the renderer value as key material.
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  const supplied = value.replace(/=+$/, "");
  return decoded.length === 32 && canonical === supplied ? decoded : null;
}

function normalizeConfig(value) {
  if (!value || typeof value !== "object") throw new TypeError("Missing H.265 configuration.");
  const url = typeof value.url === "string" ? value.url : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("The H.265 publisher received an invalid SFU URL.");
  }
  if (parsed.protocol !== "wss:") {
    throw new TypeError("The H.265 publisher requires a secure wss:// SFU URL.");
  }
  const token = typeof value.token === "string" ? value.token : "";
  if (!token || token.length > 32 * 1024) throw new TypeError("The H.265 publisher token is invalid.");
  if (!decodeMaterial(value.keyMaterial)) {
    throw new TypeError("The H.265 publisher requires 32 bytes of sender key material.");
  }
  const width = Number(value.width);
  const height = Number(value.height);
  const frameRate = Number(value.frameRate);
  const bitrate = Number(value.bitrate);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 7680 ||
    height > 4320 ||
    width % 2 ||
    height % 2
  ) {
    throw new TypeError("The H.265 publisher dimensions must be even and no larger than 8K.");
  }
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 120) {
    throw new TypeError("The H.265 publisher frame rate is invalid.");
  }
  if (!Number.isInteger(bitrate) || bitrate < MIN_BITRATE || bitrate > MAX_BITRATE) {
    throw new TypeError("The H.265 publisher bitrate is outside Armada's allowed range.");
  }
  return { url, token, keyMaterial: value.keyMaterial, width, height, frameRate, bitrate };
}

function ffmpegArgs(config, device) {
  const rate = String(config.bitrate);
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-vaapi_device",
    device,
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${config.width}x${config.height}`,
    "-framerate",
    String(config.frameRate),
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    "format=nv12,hwupload",
    "-c:v",
    "hevc_vaapi",
    "-profile:v",
    "main",
    "-rc_mode",
    "CBR",
    "-b:v",
    rate,
    "-maxrate",
    rate,
    "-bufsize",
    String(config.bitrate * 2),
    "-g",
    String(config.frameRate * 2),
    "-bf",
    "0",
    "-f",
    "hevc",
    "pipe:1",
  ];
}

function helperConfig(config) {
  return JSON.stringify({
    url: config.url,
    token: config.token,
    keyMaterial: config.keyMaterial,
    width: config.width,
    height: config.height,
    frameRate: config.frameRate,
  });
}

function parseStatusLines(chunk, carry, onLine, maxCarry = MAX_STATUS_CARRY_BYTES) {
  const combined = carry + chunk.toString("utf8");
  const lines = combined.split(/\r?\n/);
  const nextCarry = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
  // A subprocess that never writes a newline must not grow a buffer in the
  // main process without limit; keep the tail, as the FFmpeg stderr ring does.
  return nextCarry.length > maxCarry ? nextCarry.slice(-maxCarry) : nextCarry;
}

function createHevcScreenShareController({
  capability = detectCachedHevcCapability,
  spawnImpl = spawn,
  sendStatus = () => {},
  env = process.env,
} = {}) {
  let session = null;
  let lastStatus = { state: "idle", active: false };
  let startGeneration = 0;

  /**
   * `detail` reaches here parsed from the publisher's own stderr, so it must
   * not be able to answer the questions this controller answers. Spreading it
   * last let a subprocess relabel `state` — including past the rule that keeps
   * an empty signaled track in "starting" until real HEVC bytes exist — and
   * rename the session the renderer correlates against.
   */
  function emit(state, detail, sessionId = session?.sessionId) {
    const { state: _state, sessionId: _sessionId, ...rest } =
      detail && typeof detail === "object" ? detail : {};
    const status = {
      ...rest,
      state,
      ...(sessionId ? { sessionId } : {}),
    };
    lastStatus = status;
    sendStatus(status);
    if (session) session.status = status;
    return status;
  }

  /**
   * SIGTERM, then SIGKILL for a child that never processed it. FFmpeg blocked
   * in a VA-API ioctl on a wedged GPU is a first-class failure mode here, and
   * it holds the render node until something stronger arrives.
   */
  function terminate(child) {
    if (!child) return;
    let exited = false;
    let timer = null;
    child.once?.("close", () => {
      exited = true;
      clearTimeout(timer);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // process already exited
    }
    timer = setTimeout(() => {
      if (exited) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // process already exited
      }
    }, KILL_ESCALATION_MS);
    timer.unref?.();
  }

  function stopSession(reason = "stopped") {
    const active = session;
    if (!active) return emit("idle", { active: false });
    session = null;
    clearTimeout(active.captureTimer);
    clearTimeout(active.drainTimer);
    clearTimeout(active.encodeTimer);
    try {
      active.port?.close();
    } catch {
      // already closed
    }
    try {
      active.ffmpeg.stdin.end();
    } catch {
      // process already exited
    }
    try {
      active.helper.stdin.end();
    } catch {
      // process already exited
    }
    terminate(active.ffmpeg);
    terminate(active.helper);
    return emit("stopped", { active: false, reason }, active.sessionId);
  }

  function stop(reason = "stopped") {
    startGeneration += 1;
    return stopSession(reason);
  }

  async function start(rawConfig, port, sessionId) {
    // Everything that can refuse this start runs before the live session is
    // retired: a rejected configuration or an encoder that has gone away must
    // cost the user an error message, not the share they are already giving.
    const config = normalizeConfig(rawConfig);
    const configJSON = helperConfig(config);
    if (Buffer.byteLength(configJSON) > MAX_CONFIG_BYTES) {
      throw new Error("The H.265 publisher configuration is too large.");
    }
    const generation = ++startGeneration;
    const cap = await capability();
    if (generation !== startGeneration) {
      throw new Error("The H.265 publisher start was cancelled.");
    }
    if (!cap.available) throw new Error(cap.reason || "H.265 publishing is unavailable.");
    if (!path.isAbsolute(cap.helperPath || "") || !path.isAbsolute(cap.ffmpegPath || "")) {
      throw new Error("The H.265 capability probe did not resolve its publisher and FFmpeg paths.");
    }
    if (session) stopSession("replaced");

    const helper = spawnImpl(cap.helperPath, [], {
      stdio: ["pipe", "ignore", "pipe", "pipe"],
    });
    const ffmpeg = spawnImpl(cap.ffmpegPath, ffmpegArgs(config, cap.device), {
      stdio: ["pipe", "pipe", "pipe"],
      env: ffmpegChildEnvironment(env),
    });
    const active = {
      helper,
      ffmpeg,
      port,
      sessionId,
      inputBlocked: false,
      queuedFrame: null,
      framesReceived: 0,
      framesDropped: 0,
      captureStartedAt: null,
      lastFrameSampleAt: null,
      lastFrameSampleCount: 0,
      status: null,
      expectedFrameBytes: config.width * config.height * 4,
      captureTimer: null,
      drainTimer: null,
      encodeTimer: null,
    };
    session = active;
    emit("starting", {
      active: true,
      backend: cap.backend,
      encoder: cap.encoder,
      device: cap.device,
      width: config.width,
      height: config.height,
      frameRate: config.frameRate,
      bitrate: config.bitrate,
      pipelineStage: "Waiting for capture frames",
    });

    let ffmpegError = "";
    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegError = (ffmpegError + chunk.toString("utf8")).slice(-8_192);
    });

    const failed = (component, code, signal) => {
      if (session !== active) return;
      clearTimeout(active.captureTimer);
      clearTimeout(active.drainTimer);
      clearTimeout(active.encodeTimer);
      const detail = component === "Capture"
        ? String(signal || "The capture frame pump stopped.")
        : component === "FFmpeg" && ffmpegError.trim()
          ? ffmpegError.trim().split(/\r?\n/).slice(-3).join(" ")
          : `${component} exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      session = null;
      try {
        port.close();
      } catch {
        // already closed
      }
      terminate(ffmpeg);
      terminate(helper);
      emit("error", { active: false, error: detail }, active.sessionId);
    };

    // Every pipe this session holds needs an "error" listener before anything
    // is written to it. A stream error with no listener is an uncaught
    // exception, and in the main process that ends the app rather than the
    // share — which is how a helper that dies before reading its config would
    // otherwise be reported.
    ffmpeg.stdin.on("error", (error) => failed("FFmpeg", null, error.message));
    ffmpeg.stdout.on("error", (error) => failed("FFmpeg", null, error.message));
    helper.stdin.on("error", (error) => failed("Publisher", null, error.message));
    helper.stdio[3].on("error", (error) => failed("Publisher", null, error.message));

    helper.stdio[3].end(configJSON);
    ffmpeg.stdout.pipe(helper.stdin);

    let helperCarry = "";
    helper.stderr.on("data", (chunk) => {
      helperCarry = parseStatusLines(chunk, helperCarry, (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          console.warn("[screen-share] H.265 publisher:", line);
          return;
        }
        if (session !== active) return;
        if (message.state === "published") {
          // A published LiveKit track is only signaling metadata. Keep the UI
          // in "starting" until FFmpeg has produced real HEVC bytes so an
          // empty track can never be mistaken for a working screen share.
          emit("starting", {
            active: true,
            backend: cap.backend,
            encoder: cap.encoder,
            device: cap.device,
            bitrate: config.bitrate,
            framesReceived: active.framesReceived,
            framesDropped: active.framesDropped,
            pipelineStage:
              active.framesReceived > 0 ? "Encoding first frame" : "Waiting for capture frames",
            ...(message.detail && typeof message.detail === "object" ? message.detail : {}),
          });
        } else if (message.state === "progress") {
          const detail = message.detail && typeof message.detail === "object" ? message.detail : {};
          const current = active.status && typeof active.status === "object" ? active.status : {};
          const currentState = Number(detail.encodedBytes) > 0 ? "published" : "starting";
          const now = Date.now();
          const sampleElapsed = active.lastFrameSampleAt === null
            ? 0
            : now - active.lastFrameSampleAt;
          const inputFrameRate = sampleElapsed > 0
            ? ((active.framesReceived - active.lastFrameSampleCount) * 1_000) / sampleElapsed
            : 0;
          active.lastFrameSampleAt = now;
          active.lastFrameSampleCount = active.framesReceived;
          if (active.captureStartedAt !== null) {
            const expectedFrames = Math.floor(
              ((now - active.captureStartedAt) * config.frameRate) / 1_000,
            ) + 1;
            active.framesDropped = Math.max(
              active.framesDropped,
              expectedFrames - active.framesReceived,
            );
          }
          if (Number(detail.encodedBytes) > 0) {
            clearTimeout(active.encodeTimer);
            active.encodeTimer = null;
          }
          const { state: _state, ...rest } = current;
          emit(currentState, {
            ...rest,
            active: true,
            framesReceived: active.framesReceived,
            framesDropped: active.framesDropped,
            inputFrameRate,
            pipelineStage:
              Number(detail.encodedBytes) > 0
                ? "Streaming"
                : active.framesReceived > 0
                  ? "Encoding first frame"
                  : "Waiting for capture frames",
            ...detail,
          });
        } else if (message.state === "error") {
          failed("Capture", null, String(message.detail || "Publisher failed."));
        }
      });
    });

    const armCaptureWatchdog = () => {
      clearTimeout(active.captureTimer);
      active.captureTimer = null;
      if (session !== active || active.inputBlocked) return;
      active.captureTimer = setTimeout(
        () => failed("Capture", null, "Capture stopped delivering frames for 15 seconds."),
        15_000,
      );
      active.captureTimer.unref?.();
    };
    const armDrainWatchdog = () => {
      clearTimeout(active.drainTimer);
      active.drainTimer = setTimeout(
        () => failed("FFmpeg", null, "did not drain its capture input within 15 seconds"),
        15_000,
      );
      active.drainTimer.unref?.();
    };
    ffmpeg.once("error", (error) => failed("FFmpeg", null, error.message));
    helper.once("error", (error) => failed("Publisher", null, error.message));
    // "close" rather than "exit": stderr is only guaranteed flushed by then,
    // and the driver's own complaint is the most useful thing this feature can
    // put in front of a user whose hevc_vaapi refused a profile.
    ffmpeg.once("close", (code, signal) => failed("FFmpeg", code, signal));
    helper.once("close", (code, signal) => failed("Publisher", code, signal));

    const acknowledge = (sequence) => {
      if (sequence === null || session !== active) return;
      try {
        port.postMessage({ type: "frame-ack", sequence });
      } catch (error) {
        failed("Capture", null, `Could not acknowledge an encoded frame: ${error.message}`);
      }
    };
    const writeFrame = (frame, sequence) => {
      if (ffmpeg.stdin.destroyed) {
        failed("FFmpeg", null, "closed its input before accepting a frame");
        return;
      }
      try {
        // A false return still means Node accepted this frame; it asks us not
        // to write another until drain. Acknowledge it now and retain at most
        // one subsequent renderer frame while the pipe clears. This bounded
        // two-stage pipeline keeps VA-API fed without recreating the unbounded
        // MessagePort backlog that caused the original zero-frame stall.
        active.inputBlocked = !ffmpeg.stdin.write(frame);
        acknowledge(sequence);
        if (active.inputBlocked) armDrainWatchdog();
        else armCaptureWatchdog();
      } catch (error) {
        failed("FFmpeg", null, error.message);
      }
    };
    ffmpeg.stdin.on("drain", () => {
      if (session !== active) return;
      clearTimeout(active.drainTimer);
      active.drainTimer = null;
      active.inputBlocked = false;
      if (!active.queuedFrame) {
        armCaptureWatchdog();
        return;
      }
      const next = active.queuedFrame;
      active.queuedFrame = null;
      writeFrame(next.frame, next.sequence);
    });
    port.on("message", (event) => {
      if (session !== active) return;
      const data = event.data;
      if (data && typeof data === "object" && data.type === "error") {
        failed("Capture", null, String(data.error || "Frame conversion failed."));
        return;
      }
      if (data && typeof data === "object" && data.type === "stage") {
        const current = active.status && typeof active.status === "object" ? active.status : {};
        const { state: currentState = "starting", ...rest } = current;
        emit(currentState, {
          ...rest,
          active: true,
          pipelineStage: String(data.stage || "Preparing capture"),
          framesReceived: active.framesReceived,
          framesDropped: active.framesDropped,
        });
        return;
      }
      const wrapped = data && typeof data === "object" && data.type === "frame";
      const sequence = wrapped && Number.isSafeInteger(data.sequence) ? data.sequence : null;
      const payload = wrapped ? data.frame : data;
      // Electron's structured-clone implementation may surface a transferred
      // buffer as either an ArrayBuffer or a typed view depending on the
      // Chromium/V8 version. Accept both instead of silently discarding every
      // frame on runtimes that choose the latter representation.
      const frame = payload instanceof ArrayBuffer
        ? Buffer.from(payload)
        : ArrayBuffer.isView(payload)
          ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
          : null;
      if (!frame || frame.byteLength !== active.expectedFrameBytes) {
        active.framesDropped += 1;
        failed(
          "Capture",
          null,
          `The frame bridge delivered ${frame?.byteLength ?? 0} bytes; expected ${active.expectedFrameBytes}.`,
        );
        return;
      }
      if (wrapped && sequence === null) {
        failed("Capture", null, "The frame bridge delivered an invalid sequence number.");
        return;
      }
      // A received frame proves capture is alive. Do not let an older timer
      // fire while this frame is intentionally waiting for FFmpeg backpressure
      // to clear; that has its own encoder-drain watchdog below.
      clearTimeout(active.captureTimer);
      active.captureTimer = null;
      active.framesReceived += 1;
      if (active.framesReceived === 1) {
        active.captureStartedAt = Date.now();
        active.lastFrameSampleAt = active.captureStartedAt;
        active.lastFrameSampleCount = 1;
        clearTimeout(active.captureTimer);
        active.captureTimer = null;
        active.encodeTimer = setTimeout(
          () => failed("FFmpeg", null, "received frames but produced no H.265 output within 12 seconds"),
          12_000,
        );
        active.encodeTimer.unref?.();
        const current = active.status && typeof active.status === "object" ? active.status : {};
        const { state: currentState = "starting", ...rest } = current;
        emit(currentState, {
          ...rest,
          active: true,
          pipelineStage: "Encoding first frame",
          framesReceived: active.framesReceived,
          framesDropped: active.framesDropped,
        });
      }
      if (active.inputBlocked) {
        if (active.queuedFrame) {
          failed("Capture", null, "The bounded encoder input queue overflowed.");
          return;
        }
        active.queuedFrame = { frame, sequence };
        if (!active.drainTimer) armDrainWatchdog();
        return;
      }
      writeFrame(frame, sequence);
    });
    port.on("close", () => {
      if (session === active) {
        failed("Capture", null, "The capture frame channel closed unexpectedly.");
      }
    });
    port.start();
    active.captureTimer = setTimeout(
      () => failed("Capture", null, "No verified capture frame reached FFmpeg within 15 seconds."),
      15_000,
    );
    active.captureTimer.unref?.();
    return active.status;
  }

  function status() {
    if (session?.status) {
      return {
        ...session.status,
        framesReceived: session.framesReceived,
        framesDropped: session.framesDropped,
      };
    }
    return { ...lastStatus };
  }

  return { start, stop, status };
}

module.exports = {
  HELPER_PATH,
  FFMPEG_PATH,
  createHevcCapabilityDetector,
  createHevcScreenShareController,
  detectCachedHevcCapability,
  detectHevcCapability,
  ffmpegChildEnvironment,
  ffmpegArgs,
  ffmpegProbeArgs,
  normalizeConfig,
  resolveFfmpegPath,
  resolveHelperPath,
  runFfmpegProbe,
};
