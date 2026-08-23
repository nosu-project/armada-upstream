// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  desktopHevcScreenShareCapability,
  desktopScreenCaptureAccessStatus,
  openDesktopScreenCaptureSettings,
  signalDesktopWebReady,
  stopDesktopHevcScreenShare,
} from "@/lib/desktop";

function installBridge() {
  const bridge = {
    isDesktop: true as const,
    setBadge: vi.fn(),
    getInfo: vi.fn(async () => ({ platform: "linux", version: "1.2.3" })),
    getScreenSources: vi.fn(async () => []),
    onPickScreenSource: vi.fn(),
    getMicAccessStatus: vi.fn(async () => "granted" as const),
    openMicPrivacySettings: vi.fn(async () => false),
    getLinuxShareAudioSources: vi.fn(async () => ({
      supported: true,
      reason: null,
      sources: [],
    })),
    startLinuxShareAudio: vi.fn(async () => true),
    unmuteLinuxShareAudio: vi.fn(async () => true),
    stopLinuxShareAudio: vi.fn(async () => {}),
  };
  window.armadaDesktop = bridge;
  return bridge;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete window.armadaDesktop;
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Electron Linux display audio", () => {
  it("attaches venmic audio and unlinks it when LiveKit stops the video track", async () => {
    const bridge = installBridge();
    const originalVideoStop = vi.fn();
    const videoTrack = {
      addEventListener: vi.fn(),
      stop: originalVideoStop,
    } as unknown as MediaStreamTrack;
    const audioTrack = {
      addEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const audioTracks: MediaStreamTrack[] = [];
    const displayStream = {
      addTrack: (track: MediaStreamTrack) => audioTracks.push(track),
      getAudioTracks: () => audioTracks,
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const audioStream = {
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const venmicDevice = {
      deviceId: "venmic-id",
      groupId: "",
      kind: "audioinput" as const,
      label: "vencord-screen-share",
      toJSON: () => ({}),
    };
    const getDisplayMedia = vi.fn(async () => displayStream);
    const getUserMedia = vi.fn(async () => audioStream);
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [venmicDevice]),
      getDisplayMedia,
      getUserMedia,
    } as unknown as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    await expect(desktop.prepareDesktopShareAudio({ mode: "system" })).resolves.toBe(true);

    const result = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(result).toBe(displayStream);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: false,
      audio: expect.objectContaining({
        deviceId: { exact: "venmic-id" },
        echoCancellation: false,
      }),
    });
    expect(displayStream.getAudioTracks()).toEqual([audioTrack]);
    expect(bridge.unmuteLinuxShareAudio).toHaveBeenCalledOnce();

    videoTrack.stop();
    expect(originalVideoStop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.stopLinuxShareAudio).toHaveBeenCalledOnce();
  });

  it("unlinks a newly prepared venmic route when display capture fails", async () => {
    const bridge = installBridge();
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => []),
      getDisplayMedia,
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    getDisplayMedia.mockImplementation(async () => {
      await desktop.prepareDesktopShareAudio({ mode: "system" });
      throw new DOMException("capture failed", "NotAllowedError");
    });

    await expect(navigator.mediaDevices.getDisplayMedia({ video: true })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(bridge.stopLinuxShareAudio).toHaveBeenCalledOnce();
  });

  it("preserves the current venmic route when a source switch is cancelled", async () => {
    const bridge = installBridge();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => []),
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException("cancelled", "NotAllowedError");
      }),
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    await desktop.prepareDesktopShareAudio({ mode: "system" });

    await expect(navigator.mediaDevices.getDisplayMedia({ video: true })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(bridge.stopLinuxShareAudio).not.toHaveBeenCalled();
  });

  it("does not let the old video cleanup unlink a replacement audio route", async () => {
    const bridge = installBridge();
    const firstVideoStop = vi.fn();
    const secondVideoStop = vi.fn();
    const firstVideo = {
      addEventListener: vi.fn(),
      stop: firstVideoStop,
    } as unknown as MediaStreamTrack;
    const secondVideo = {
      addEventListener: vi.fn(),
      stop: secondVideoStop,
    } as unknown as MediaStreamTrack;
    const firstAudio = {
      addEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const secondAudio = {
      addEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const displayStreams = [firstVideo, secondVideo].map((video) => {
      const audioTracks: MediaStreamTrack[] = [];
      return {
        addTrack: (track: MediaStreamTrack) => audioTracks.push(track),
        getAudioTracks: () => audioTracks,
        getVideoTracks: () => [video],
      } as unknown as MediaStream;
    });
    const audioStreams = [firstAudio, secondAudio].map(
      (audio) => ({ getAudioTracks: () => [audio] }) as unknown as MediaStream,
    );
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [{
        deviceId: "venmic-id",
        groupId: "",
        kind: "audioinput" as const,
        label: "vencord-screen-share",
        toJSON: () => ({}),
      }]),
      getDisplayMedia: vi
        .fn<() => Promise<MediaStream>>()
        .mockResolvedValueOnce(displayStreams[0])
        .mockResolvedValueOnce(displayStreams[1]),
      getUserMedia: vi
        .fn<() => Promise<MediaStream>>()
        .mockResolvedValueOnce(audioStreams[0])
        .mockResolvedValueOnce(audioStreams[1]),
    } as unknown as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    await desktop.prepareDesktopShareAudio({ mode: "system" });
    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    await desktop.prepareDesktopShareAudio({ mode: "applications", sourceIds: ["game"] });
    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    firstVideo.stop();
    expect(firstVideoStop).toHaveBeenCalledOnce();
    expect(firstAudio.stop).toHaveBeenCalledOnce();
    expect(bridge.stopLinuxShareAudio).not.toHaveBeenCalled();

    secondVideo.stop();
    expect(secondVideoStop).toHaveBeenCalledOnce();
    expect(secondAudio.stop).toHaveBeenCalledOnce();
    expect(bridge.stopLinuxShareAudio).toHaveBeenCalledOnce();
  });

  it("defers a declined audio route until the replacement capture succeeds", async () => {
    const bridge = installBridge();
    const displayStream = {
      addTrack: vi.fn(),
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const getDisplayMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockRejectedValueOnce(new Error("user cancelled"))
      .mockResolvedValueOnce(displayStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => []),
        getDisplayMedia,
        getUserMedia: vi.fn(),
      } as unknown as MediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    // A share is live with system audio routed.
    await desktop.prepareDesktopShareAudio({ mode: "system" });
    bridge.stopLinuxShareAudio.mockClear();

    // The user opens the picker again and chooses "No audio". Nothing may be
    // torn down yet: they can still cancel back to the share they have.
    desktop.declineDesktopShareAudio();
    expect(bridge.stopLinuxShareAudio).not.toHaveBeenCalled();

    await expect(
      navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),
    ).rejects.toThrow(/cancelled/);
    expect(bridge.stopLinuxShareAudio).not.toHaveBeenCalled();

    // Only a capture that actually replaces the share retires the old route.
    desktop.declineDesktopShareAudio();
    await expect(
      navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),
    ).resolves.toBe(displayStream);
    expect(bridge.stopLinuxShareAudio).toHaveBeenCalledOnce();
  });

  it("does not let a failed attach unlink a route prepared after it", async () => {
    const bridge = installBridge();
    const displayStream = {
      addTrack: vi.fn(),
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    let releaseUserMedia: (() => void) | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((_resolve, reject) => {
      releaseUserMedia = () => reject(new Error("device disappeared"));
    }));
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [{
        deviceId: "venmic-id",
        groupId: "",
        kind: "audioinput" as const,
        label: "vencord-screen-share",
        toJSON: () => ({}),
      }]),
      getDisplayMedia: vi.fn(async () => displayStream),
      getUserMedia,
    } as unknown as MediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    const desktop = await import("@/lib/desktop");
    desktop.installDesktopDisplayMediaAudio();
    await desktop.prepareDesktopShareAudio({ mode: "system" });

    // The attach stalls in getUserMedia. Everywhere else in this file that
    // window is treated as a place a NEWER share can appear; the failure path
    // was the one teardown that ignored which route it was tearing down.
    const capture = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    await vi.waitFor(() => expect(releaseUserMedia).toBeDefined());
    await desktop.prepareDesktopShareAudio({ mode: "applications", sourceIds: ["game"] });
    bridge.stopLinuxShareAudio.mockClear();

    releaseUserMedia?.();
    await expect(capture).resolves.toBe(displayStream);

    expect(bridge.stopLinuxShareAudio).not.toHaveBeenCalled();
  });
});

describe("desktop bundle boot signal", () => {
  it("tells the shell the bundle painted", () => {
    const bridge = installBridge();
    const signalWebReady = vi.fn();
    window.armadaDesktop = { ...bridge, signalWebReady };

    signalDesktopWebReady();

    expect(signalWebReady).toHaveBeenCalledOnce();
  });

  it("is a no-op on the web and on a shell that predates the bundle store", () => {
    // A newer web bundle has to run inside an older shell — that is the whole
    // point of shipping them separately — so an absent method is expected, not
    // an error.
    expect(() => signalDesktopWebReady()).not.toThrow();

    installBridge();
    expect(() => signalDesktopWebReady()).not.toThrow();
  });

  it("does not let a failing bridge take down the first paint", () => {
    const bridge = installBridge();
    window.armadaDesktop = {
      ...bridge,
      signalWebReady: vi.fn(() => {
        throw new Error("bridge is gone");
      }),
    };

    expect(() => signalDesktopWebReady()).not.toThrow();
  });
});

describe("desktop H.265 and Screen Recording bridges", () => {
  it("fails closed when an older shell has no custom publisher", async () => {
    installBridge();

    await expect(desktopHevcScreenShareCapability()).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/does not contain/i),
    });
    await expect(stopDesktopHevcScreenShare()).resolves.toEqual({
      state: "idle",
      active: false,
    });
  });

  it("forwards the custom publisher capability and stop lifecycle", async () => {
    const bridge = installBridge();
    const capability = {
      available: true,
      encoder: "hevc_vaapi",
      backend: "FFmpeg",
      device: "/dev/dri/renderD128",
      reason: null,
    };
    const stopped = { state: "stopped" as const, active: false };
    window.armadaDesktop = {
      ...bridge,
      getHevcScreenShareCapability: vi.fn(async () => capability),
      stopHevcScreenShare: vi.fn(async () => stopped),
    };

    await expect(desktopHevcScreenShareCapability()).resolves.toEqual(capability);
    await expect(stopDesktopHevcScreenShare()).resolves.toEqual(stopped);
    expect(window.armadaDesktop.stopHevcScreenShare).toHaveBeenCalledOnce();
  });

  it("forwards macOS Screen Recording state and settings actions", async () => {
    const bridge = installBridge();
    const openScreenCapturePrivacySettings = vi.fn(async () => true);
    window.armadaDesktop = {
      ...bridge,
      getScreenCaptureAccessStatus: vi.fn(async () => "denied" as const),
      openScreenCapturePrivacySettings,
    };

    await expect(desktopScreenCaptureAccessStatus()).resolves.toBe("denied");
    await expect(openDesktopScreenCaptureSettings()).resolves.toBe(true);
    expect(openScreenCapturePrivacySettings).toHaveBeenCalledOnce();
  });
});

describe("desktop H.265 frame-pump lifecycle", () => {
  const stopped = { state: "stopped" as const, active: false };
  const liveTrack = () => ({
    readyState: "live",
    contentHint: "",
  }) as unknown as MediaStreamTrack;

  function installConversionCapability() {
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("OffscreenCanvas", class {});
  }

  it("cancels a start stopped during its initial shell teardown", async () => {
    installConversionCapability();
    const bridge = installBridge();
    let releaseInitialStop!: () => void;
    const initialStop = new Promise<typeof stopped>((resolve) => {
      releaseInitialStop = () => resolve(stopped);
    });
    const stopHevcScreenShare = vi
      .fn<() => Promise<typeof stopped>>()
      .mockReturnValueOnce(initialStop)
      .mockResolvedValue(stopped);
    const startHevcScreenShare = vi.fn();
    window.armadaDesktop = {
      ...bridge,
      stopHevcScreenShare,
      startHevcScreenShare,
    };

    const desktop = await import("@/lib/desktop");
    const starting = desktop.startDesktopHevcScreenShare(liveTrack(), {
      url: "wss://sfu.example",
      token: "token",
      keyMaterial: "a2V5",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 5_000_000,
    });
    const rejected = expect(starting).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(stopHevcScreenShare).toHaveBeenCalledTimes(1));

    await desktop.stopDesktopHevcScreenShare();
    releaseInitialStop();

    await rejected;
    expect(startHevcScreenShare).not.toHaveBeenCalled();
  });

  it("lets a newer start supersede one waiting in the initial shell stop", async () => {
    installConversionCapability();
    const bridge = installBridge();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstStop = new Promise<typeof stopped>((resolve) => {
      releaseFirst = () => resolve(stopped);
    });
    const secondStop = new Promise<typeof stopped>((resolve) => {
      releaseSecond = () => resolve(stopped);
    });
    const stopHevcScreenShare = vi
      .fn<() => Promise<typeof stopped>>()
      .mockReturnValueOnce(firstStop)
      .mockReturnValueOnce(secondStop);
    const startHevcScreenShare = vi.fn();
    window.armadaDesktop = {
      ...bridge,
      stopHevcScreenShare,
      startHevcScreenShare,
    };
    const desktop = await import("@/lib/desktop");
    const config = {
      url: "wss://sfu.example",
      token: "token",
      keyMaterial: "a2V5",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 5_000_000,
    };

    const first = desktop.startDesktopHevcScreenShare(liveTrack(), config);
    const firstRejected = expect(first).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(stopHevcScreenShare).toHaveBeenCalledTimes(1));
    const secondTrack = { readyState: "ended", contentHint: "" } as unknown as MediaStreamTrack;
    const second = desktop.startDesktopHevcScreenShare(secondTrack, config);
    const secondRejected = expect(second).rejects.toThrow(/ended before capture/i);
    await vi.waitFor(() => expect(stopHevcScreenShare).toHaveBeenCalledTimes(2));

    releaseSecond();
    releaseFirst();

    await Promise.all([firstRejected, secondRejected]);
    expect(startHevcScreenShare).not.toHaveBeenCalled();
  });

  it("binds frames only to the MessagePort for the active shell session", async () => {
    class FakeVideoFrame {
      displayWidth = 1280;
      displayHeight = 720;
      codedWidth = 1280;
      codedHeight = 720;
      timestamp = 1;
      duration = null;
      copyTo = vi.fn(async () => undefined);
      close = vi.fn();
    }
    class FakeOffscreenCanvas {
      getContext() {
        return {
          fillStyle: "black",
          fillRect: vi.fn(),
          drawImage: vi.fn(),
        };
      }
    }
    class FakeMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
    class FakePort extends EventTarget {
      closed = false;
      messages: unknown[] = [];
      start = vi.fn();
      close = vi.fn(() => {
        this.closed = true;
      });
      postMessage = vi.fn((message: { type?: string; sequence?: number }) => {
        this.messages.push(message);
        if (message.type === "frame") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: { type: "frame-ack", sequence: message.sequence },
          })));
        }
      });
    }
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("MediaStream", FakeMediaStream);

    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    video.play = vi.fn(async () => undefined);
    video.pause = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue(video);

    const trackEvents = new EventTarget();
    const track = Object.assign(trackEvents, {
      readyState: "live",
      muted: false,
      contentHint: "",
      getSettings: () => ({ width: 1280, height: 720 }),
      stop: vi.fn(),
    }) as unknown as MediaStreamTrack;
    const stalePort = new FakePort();
    const activePort = new FakePort();
    const bridge = installBridge();
    const desktopModule = await import("@/lib/desktop");
    const startHevcScreenShare = vi.fn(async () => {
      desktopModule.acceptDesktopHevcScreenShareFramePort(
        "stale-session",
        stalePort as unknown as MessagePort,
      );
      window.setTimeout(() => desktopModule.acceptDesktopHevcScreenShareFramePort(
        "active-session",
        activePort as unknown as MessagePort,
      ), 0);
      return { state: "starting" as const, active: true, sessionId: "active-session" };
    });
    window.armadaDesktop = {
      ...bridge,
      stopHevcScreenShare: vi.fn(async () => stopped),
      startHevcScreenShare,
      getHevcScreenShareStatus: vi.fn(async () => ({
        state: "published" as const,
        active: true,
        sessionId: "active-session",
        encodedBytes: 1024,
      })),
    };
    await expect(desktopModule.startDesktopHevcScreenShare(track, {
      url: "wss://sfu.example",
      token: "token",
      keyMaterial: "a2V5",
      width: 1280,
      height: 720,
      frameRate: 30,
      bitrate: 5_000_000,
    })).resolves.toMatchObject({ state: "published", encodedBytes: 1024 });

    expect(stalePort.messages).toEqual([]);
    expect(activePort.messages).toContainEqual(expect.objectContaining({ type: "frame" }));
    await desktopModule.stopDesktopHevcScreenShare();
    expect(stalePort.close).toHaveBeenCalled();
    expect(activePort.close).toHaveBeenCalled();
  });
});
