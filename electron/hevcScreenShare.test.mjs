// @vitest-environment node

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  HELPER_PATH,
  FFMPEG_PATH,
  createHevcCapabilityDetector,
  createHevcScreenShareController,
  detectHevcCapability,
  ffmpegArgs,
  ffmpegChildEnvironment,
  ffmpegProbeArgs,
  normalizeConfig,
  resolveFfmpegPath,
  resolveHelperPath,
  runFfmpegProbe,
} = require("./hevcScreenShare.js");

const bundledHelper = "/opt/Armada/resources/armada-hevc-publisher";
const renderD128 = "/dev/dri/renderD128";
const keyMaterial = Buffer.alloc(32, 7).toString("base64");
const validConfig = {
  url: "wss://voice.example.test",
  token: "signed-token",
  keyMaterial,
  width: 16,
  height: 16,
  frameRate: 60,
  bitrate: 4_000_000,
};
const capability = {
  available: true,
  encoder: "HEVC Main",
  backend: "FFmpeg hevc_vaapi",
  device: renderD128,
  helperPath: bundledHelper,
  ffmpegPath: FFMPEG_PATH,
  reason: null,
};

function fakeFs({ files = [], nodes = [] } = {}) {
  const present = new Set(files);
  return {
    statSync: vi.fn((file) => present.has(file)
      ? { isFile: () => true }
      : undefined),
    existsSync: vi.fn((file) => file === "/dev/dri" || present.has(file)),
    accessSync: vi.fn((file) => {
      if (!present.has(file)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    }),
    readdirSync: vi.fn((directory) => {
      if (directory !== "/dev/dri") throw new Error("unexpected directory");
      return nodes;
    }),
  };
}

function fakeWritable(results = [true]) {
  const stream = new EventEmitter();
  let index = 0;
  stream.destroyed = false;
  stream.write = vi.fn(() => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  });
  stream.end = vi.fn();
  return stream;
}

function fakeChild(writeResults = [true]) {
  const child = new EventEmitter();
  child.stdin = fakeWritable(writeResults);
  child.stdout = new EventEmitter();
  child.stdout.pipe = vi.fn();
  child.stderr = new EventEmitter();
  child.stdio = [child.stdin, child.stdout, child.stderr, fakeWritable()];
  child.kill = vi.fn();
  return child;
}

function fakePort() {
  const port = new EventEmitter();
  port.start = vi.fn();
  port.close = vi.fn();
  port.postMessage = vi.fn();
  return port;
}

function controllerHarness({ ffmpegWrites = [true] } = {}) {
  const helper = fakeChild();
  const ffmpeg = fakeChild(ffmpegWrites);
  const spawnImpl = vi.fn()
    .mockReturnValueOnce(helper)
    .mockReturnValueOnce(ffmpeg);
  const sendStatus = vi.fn();
  const controller = createHevcScreenShareController({
    capability: () => capability,
    spawnImpl,
    sendStatus,
    env: {},
  });
  const port = fakePort();
  return { controller, helper, ffmpeg, port, sendStatus, spawnImpl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Linux H.265 capability detection", () => {
  it("stays unavailable outside Linux so Windows and macOS use Chromium codecs", async () => {
    expect(await detectHevcCapability({ platform: "darwin" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("only on Linux"),
    });
  });

  it("requires the package's executable publisher", async () => {
    const fsImpl = fakeFs({ files: [FFMPEG_PATH, renderD128], nodes: ["renderD128"] });
    expect(await detectHevcCapability({
      platform: "linux",
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
    })).toMatchObject({
      available: false,
      reason: expect.stringContaining("missing an executable H.265 publisher"),
    });
  });

  it("uses the bundled helper in AppImage, deb, and current Flatpak packages", () => {
    const fsImpl = fakeFs({ files: [bundledHelper] });
    expect(resolveHelperPath({
      env: {},
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
    })).toBe(bundledHelper);
  });

  it("retains the legacy Flatpak helper fallback", () => {
    const fsImpl = fakeFs({ files: [HELPER_PATH] });
    expect(resolveHelperPath({
      env: { FLATPAK_ID: "buzz.armada.app" },
      resourcesPath: "/missing/resources",
      fsImpl,
    })).toBe(HELPER_PATH);
  });

  it("strips AppImage library paths before starting host FFmpeg", () => {
    const env = {
      APPIMAGE: "/downloads/Armada.AppImage",
      APPDIR: "/tmp/.mount_armada",
      PATH: "/tmp/.mount_armada/usr/bin:/usr/bin:relative:/opt/bin",
      LD_LIBRARY_PATH: "/tmp/.mount_armada/usr/lib:/usr/lib",
      KEEP_ME: "yes",
    };
    expect(ffmpegChildEnvironment(env)).toEqual({
      ...env,
      PATH: "/usr/bin:/opt/bin",
      LD_LIBRARY_PATH: "/usr/lib",
    });
  });

  it("resolves a host FFmpeg without searching inside the AppImage mount", () => {
    const fsImpl = fakeFs({ files: ["/opt/bin/ffmpeg"] });
    expect(resolveFfmpegPath({
      env: {
        APPIMAGE: "/downloads/Armada.AppImage",
        APPDIR: "/tmp/.mount_armada",
        PATH: "/tmp/.mount_armada/usr/bin:/opt/bin",
      },
      fsImpl,
    })).toBe("/opt/bin/ffmpeg");
  });

  it("runs a real two-frame encode probe with the same VA-API arguments", async () => {
    const fsImpl = fakeFs({
      files: [bundledHelper, FFMPEG_PATH, renderD128],
      nodes: ["renderD128"],
    });
    const probeImpl = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from([0, 0, 1]),
      stderr: "",
    }));

    expect(await detectHevcCapability({
      platform: "linux",
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
      probeImpl,
    })).toEqual(capability);
    expect(probeImpl).toHaveBeenCalledWith(
      FFMPEG_PATH,
      ffmpegProbeArgs(renderD128),
      expect.objectContaining({
        timeout: 2_500,
        input: expect.any(Buffer),
      }),
    );
    expect(probeImpl.mock.calls[0][2].input.byteLength).toBe(320 * 180 * 4 * 2);
  });

  it("tries later render nodes and reports the exact working device", async () => {
    const renderD129 = "/dev/dri/renderD129";
    const fsImpl = fakeFs({
      files: [bundledHelper, FFMPEG_PATH, renderD128, renderD129],
      nodes: ["card0", "renderD129", "renderD128"],
    });
    const probeImpl = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0), stderr: "driver rejected profile" })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from([1]), stderr: "" });

    const result = await detectHevcCapability({
      platform: "linux",
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
      probeImpl,
    });

    expect(result).toMatchObject({ available: true, device: renderD129 });
    expect(probeImpl).toHaveBeenCalledTimes(2);
  });

  it("does not advertise H.265 when FFmpeg produces no encoded output", async () => {
    const fsImpl = fakeFs({
      files: [bundledHelper, FFMPEG_PATH, renderD128],
      nodes: ["renderD128"],
    });
    const result = await detectHevcCapability({
      platform: "linux",
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
      probeImpl: () => ({ status: 0, stdout: Buffer.alloc(0), stderr: "" }),
    });
    expect(result).toMatchObject({
      available: false,
      reason: expect.stringContaining("produced no HEVC output"),
    });
  });

  it("drives FFmpeg through an asynchronous child process", async () => {
    const child = fakeChild();
    child.stdin.end = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from([0, 0, 1]));
        child.emit("close", 0, null);
      });
    });
    const spawnImpl = vi.fn(() => child);

    const result = await runFfmpegProbe(FFMPEG_PATH, ffmpegProbeArgs(renderD128), {
      env: { PATH: "/usr/bin" },
      input: Buffer.from([1, 2, 3]),
      spawnImpl,
    });

    expect(result).toMatchObject({ status: 0, stdout: 3, stderr: "" });
    expect(spawnImpl).toHaveBeenCalledWith(
      FFMPEG_PATH,
      ffmpegProbeArgs(renderD128),
      {
        env: { PATH: "/usr/bin" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it("kills a probe that exceeds its bounded output budget", async () => {
    const child = fakeChild();
    child.stdin.end = vi.fn(() => {
      queueMicrotask(() => child.stderr.emit("data", Buffer.from("driver diagnostic")));
    });

    const result = await runFfmpegProbe(FFMPEG_PATH, [], {
      input: Buffer.from([1]),
      maxBuffer: 8,
      spawnImpl: () => child,
    });

    expect(result.error).toMatchObject({ code: "ENOBUFS" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("returns control while a hardware probe is still running", async () => {
    const fsImpl = fakeFs({
      files: [bundledHelper, FFMPEG_PATH, renderD128],
      nodes: ["renderD128"],
    });
    let finishProbe;
    const probeImpl = vi.fn(() => new Promise((resolve) => {
      finishProbe = resolve;
    }));
    const pending = detectHevcCapability({
      platform: "linux",
      resourcesPath: "/opt/Armada/resources",
      fsImpl,
      probeImpl,
    });
    const anotherTask = vi.fn();
    queueMicrotask(anotherTask);

    await Promise.resolve();
    expect(anotherTask).toHaveBeenCalledOnce();
    finishProbe({ status: 0, stdout: Buffer.from([1]), stderr: "" });
    await expect(pending).resolves.toEqual(capability);
  });

  it("deduplicates in-flight probes and briefly caches failures", async () => {
    let timestamp = 100;
    let finishProbe;
    const unavailable = { ...capability, available: false, reason: "driver unavailable" };
    const detect = vi.fn(() => new Promise((resolve) => {
      finishProbe = resolve;
    }));
    const cachedDetect = createHevcCapabilityDetector({
      detect,
      now: () => timestamp,
      successTtlMs: 1_000,
      failureTtlMs: 50,
    });

    const first = cachedDetect();
    const concurrent = cachedDetect();
    await Promise.resolve();
    finishProbe(unavailable);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      unavailable,
      unavailable,
    ]);
    expect(detect).toHaveBeenCalledOnce();
    await expect(cachedDetect()).resolves.toBe(unavailable);
    expect(detect).toHaveBeenCalledOnce();

    timestamp += 51;
    const retry = cachedDetect();
    await Promise.resolve();
    finishProbe(capability);
    await expect(retry).resolves.toBe(capability);
    expect(detect).toHaveBeenCalledTimes(2);
  });
});

describe("H.265 publisher configuration", () => {
  it("accepts the secure bounded configuration used by the renderer", () => {
    expect(normalizeConfig(validConfig)).toEqual(validConfig);
  });

  it.each([
    ["an insecure SFU URL", { url: "ws://voice.example.test" }],
    ["short key material", { keyMaterial: Buffer.alloc(31).toString("base64") }],
    ["odd dimensions", { width: 17 }],
    ["an excessive frame rate", { frameRate: 121 }],
    ["an excessive bitrate", { bitrate: 25_000_001 }],
  ])("rejects %s", (_label, override) => {
    expect(() => normalizeConfig({ ...validConfig, ...override })).toThrow();
  });

  it("pins HEVC Main CBR output without B-frames", () => {
    const args = ffmpegArgs(validConfig, renderD128);
    expect(args).toEqual(expect.arrayContaining([
      "-vaapi_device", renderD128,
      "-c:v", "hevc_vaapi",
      "-profile:v", "main",
      "-rc_mode", "CBR",
      "-b:v", "4000000",
      "-maxrate", "4000000",
      "-bf", "0",
      "-f", "hevc",
    ]));
  });
});

describe("H.265 process controller", () => {
  it("starts resolved binaries and passes secrets over the dedicated config pipe", async () => {
    vi.useFakeTimers();
    const { controller, helper, port, spawnImpl } = controllerHarness();

    const status = await controller.start(validConfig, port, "session-1");

    expect(status).toMatchObject({
      state: "starting",
      active: true,
      sessionId: "session-1",
      pipelineStage: "Waiting for capture frames",
    });
    expect(spawnImpl.mock.calls[0][0]).toBe(bundledHelper);
    expect(spawnImpl.mock.calls[0][1]).toEqual([]);
    expect(spawnImpl.mock.calls[1][0]).toBe(FFMPEG_PATH);
    expect(helper.stdio[3].end).toHaveBeenCalledWith(JSON.stringify({
      url: validConfig.url,
      token: validConfig.token,
      keyMaterial: validConfig.keyMaterial,
      width: validConfig.width,
      height: validConfig.height,
      frameRate: validConfig.frameRate,
    }));
    expect(port.start).toHaveBeenCalledOnce();
    controller.stop("test");
  });

  it("accepts typed frame views, writes them to FFmpeg, and acknowledges sequence ids", async () => {
    vi.useFakeTimers();
    const { controller, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-2");
    const frame = new Uint8Array(validConfig.width * validConfig.height * 4);

    port.emit("message", { data: { type: "frame", sequence: 9, frame } });

    expect(ffmpeg.stdin.write).toHaveBeenCalledWith(expect.any(Buffer));
    expect(ffmpeg.stdin.write.mock.calls[0][0].byteLength).toBe(frame.byteLength);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "frame-ack", sequence: 9 });
    expect(controller.status()).toMatchObject({
      framesReceived: 1,
      pipelineStage: "Encoding first frame",
    });
    controller.stop("test");
  });

  it("does not call an empty signaled track published until encoded bytes exist", async () => {
    vi.useFakeTimers();
    const { controller, helper, port } = controllerHarness();
    await controller.start(validConfig, port, "session-3");

    helper.stderr.emit("data", Buffer.from(
      '{"state":"published","detail":{"publisherState":"published"}}\n',
    ));
    expect(controller.status()).toMatchObject({ state: "starting" });

    helper.stderr.emit("data", Buffer.from(
      '{"state":"progress","detail":{"encodedBytes":4096,"encodedBitrate":18000000}}\n',
    ));
    expect(controller.status()).toMatchObject({
      state: "published",
      pipelineStage: "Streaming",
      encodedBytes: 4096,
    });
    controller.stop("test");
  });

  it("fails immediately when the frame bridge delivers the wrong byte count", async () => {
    vi.useFakeTimers();
    const { controller, ffmpeg, helper, port } = controllerHarness();
    await controller.start(validConfig, port, "session-4");

    port.emit("message", {
      data: { type: "frame", sequence: 1, frame: new Uint8Array(4) },
    });

    expect(controller.status()).toMatchObject({
      state: "error",
      active: false,
      error: expect.stringContaining("expected 1024"),
    });
    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGTERM");
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds encoder backpressure to one queued frame", async () => {
    vi.useFakeTimers();
    const { controller, port } = controllerHarness({ ffmpegWrites: [false] });
    await controller.start(validConfig, port, "session-5");
    const frame = () => new Uint8Array(validConfig.width * validConfig.height * 4);

    port.emit("message", { data: { type: "frame", sequence: 1, frame: frame() } });
    port.emit("message", { data: { type: "frame", sequence: 2, frame: frame() } });
    port.emit("message", { data: { type: "frame", sequence: 3, frame: frame() } });

    expect(controller.status()).toMatchObject({
      state: "error",
      error: expect.stringContaining("bounded encoder input queue overflowed"),
    });
  });

  it("fails a silent capture instead of spinning forever", async () => {
    vi.useFakeTimers();
    const { controller, port } = controllerHarness();
    await controller.start(validConfig, port, "session-6");

    vi.advanceTimersByTime(15_000);

    expect(controller.status()).toMatchObject({
      state: "error",
      error: expect.stringContaining("No verified capture frame reached FFmpeg"),
    });
  });

  it("fails when frames arrive but FFmpeg never emits H.265 bytes", async () => {
    vi.useFakeTimers();
    const { controller, port } = controllerHarness();
    await controller.start(validConfig, port, "session-7");
    port.emit("message", {
      data: {
        type: "frame",
        sequence: 1,
        frame: new Uint8Array(validConfig.width * validConfig.height * 4),
      },
    });

    vi.advanceTimersByTime(12_000);

    expect(controller.status()).toMatchObject({
      state: "error",
      error: expect.stringContaining("produced no H.265 output"),
    });
  });

  it("reports a broken config pipe instead of crashing the main process", async () => {
    vi.useFakeTimers();
    const { controller, helper, port } = controllerHarness();
    await controller.start(validConfig, port, "session-config-pipe");

    // An EventEmitter with no "error" listener throws out of emit(), which in
    // the Electron main process is an uncaught exception that takes the whole
    // app down mid-call.
    expect(() => helper.stdio[3].emit("error", new Error("EPIPE"))).not.toThrow();

    expect(controller.status()).toMatchObject({
      state: "error",
      active: false,
      error: expect.stringContaining("EPIPE"),
    });
  });

  it("reports a broken encoder output pipe instead of crashing", async () => {
    vi.useFakeTimers();
    const { controller, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-stdout-pipe");

    // pipe() does not forward source errors to the destination.
    expect(() => ffmpeg.stdout.emit("error", new Error("EIO"))).not.toThrow();

    expect(controller.status()).toMatchObject({
      state: "error",
      error: expect.stringContaining("EIO"),
    });
  });

  it("validates a replacement configuration before retiring the live session", async () => {
    vi.useFakeTimers();
    const { controller, helper, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-live");

    await expect(
      controller.start({ ...validConfig, width: 17 }, fakePort(), "session-rejected"),
    ).rejects.toThrow();

    expect(controller.status()).toMatchObject({
      sessionId: "session-live",
      active: true,
    });
    expect(helper.kill).not.toHaveBeenCalled();
    expect(ffmpeg.kill).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();
    controller.stop("test");
  });

  it("keeps an unavailable encoder from retiring the live session", async () => {
    vi.useFakeTimers();
    const helper = fakeChild();
    const ffmpeg = fakeChild();
    let available = true;
    const controller = createHevcScreenShareController({
      capability: () => (available ? capability : { available: false, reason: "driver went away" }),
      spawnImpl: vi.fn().mockReturnValueOnce(helper).mockReturnValueOnce(ffmpeg),
      env: {},
    });
    const port = fakePort();
    await controller.start(validConfig, port, "session-live");

    available = false;
    await expect(
      controller.start(validConfig, fakePort(), "session-rejected"),
    ).rejects.toThrow("driver went away");

    expect(controller.status()).toMatchObject({ sessionId: "session-live", active: true });
    expect(helper.kill).not.toHaveBeenCalled();
    controller.stop("test");
  });

  it("does not let publisher output relabel the controller's own state", async () => {
    vi.useFakeTimers();
    const { controller, helper, port } = controllerHarness();
    await controller.start(validConfig, port, "session-authority");

    // The detail object is JSON parsed straight off a subprocess's stderr. It
    // describes the publisher, and must not be able to answer questions the
    // controller answers -- notably the rule that keeps an empty signaled
    // track in "starting" until real HEVC bytes exist.
    helper.stderr.emit("data", Buffer.from(
      '{"state":"published","detail":{"state":"published","sessionId":"forged"}}\n',
    ));

    expect(controller.status()).toMatchObject({
      state: "starting",
      sessionId: "session-authority",
    });
    controller.stop("test");
  });

  it("reports FFmpeg's own diagnostic rather than a bare exit code", async () => {
    vi.useFakeTimers();
    const { controller, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-diagnostic");

    // "exit" fires while stderr may still have buffered data; only "close"
    // guarantees the driver's complaint has been read.
    ffmpeg.emit("exit", 1, null);
    ffmpeg.stderr.emit("data", Buffer.from("Failed to upload frame: invalid parameter\n"));
    ffmpeg.emit("close", 1, null);

    expect(controller.status()).toMatchObject({
      state: "error",
      error: expect.stringContaining("invalid parameter"),
    });
  });

  it("escalates to SIGKILL when a child ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const { controller, helper, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-escalate");

    controller.stop("test");
    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGTERM");
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
    expect(ffmpeg.kill).not.toHaveBeenCalledWith("SIGKILL");

    // FFmpeg blocked in a VA-API ioctl on a wedged GPU never processes the
    // signal, and holds the render node until something stronger arrives.
    vi.advanceTimersByTime(5_000);

    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGKILL");
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not escalate against a child that already exited", async () => {
    vi.useFakeTimers();
    const { controller, helper, ffmpeg, port } = controllerHarness();
    await controller.start(validConfig, port, "session-clean-exit");

    controller.stop("test");
    ffmpeg.emit("close", 0, null);
    helper.emit("close", 0, null);
    vi.advanceTimersByTime(5_000);

    expect(ffmpeg.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(helper.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("bounds an unterminated publisher status line", async () => {
    vi.useFakeTimers();
    const { controller, helper, port } = controllerHarness();
    await controller.start(validConfig, port, "session-carry");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let index = 0; index < 8; index += 1) {
      helper.stderr.emit("data", Buffer.alloc(32 * 1024, 0x61));
    }
    helper.stderr.emit("data", Buffer.from("\n"));

    // Every other buffer in this file is capped; an unterminated line must not
    // be the one unbounded accumulator in the main process.
    expect(warn.mock.calls.at(-1)?.[1].length).toBeLessThanOrEqual(64 * 1024);
    warn.mockRestore();
    controller.stop("test");
  });

  it("cancels a start waiting on capability detection before spawning", async () => {
    let finishCapability;
    const capabilityPending = new Promise((resolve) => {
      finishCapability = resolve;
    });
    const spawnImpl = vi.fn();
    const controller = createHevcScreenShareController({
      capability: () => capabilityPending,
      spawnImpl,
    });
    const port = fakePort();

    const start = controller.start(validConfig, port, "cancelled-session");
    controller.stop("requested");
    finishCapability(capability);

    await expect(start).rejects.toThrow("start was cancelled");
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(port.start).not.toHaveBeenCalled();
  });
});
