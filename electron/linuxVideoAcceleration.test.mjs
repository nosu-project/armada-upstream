import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  configureLinuxVideoEncoding,
  mergeFeatureSwitch,
  readLinuxVideoEncoderMode,
  writeLinuxVideoEncoderMode,
} = require("./linuxVideoAcceleration.js");

describe("Linux Electron video encoding", () => {
  it("keeps software-compatible WebRTC encoding as the safe default", () => {
    const commandLine = {
      getSwitchValue: vi.fn(() => "ExistingFeature"),
      appendSwitch: vi.fn(),
    };
    expect(configureLinuxVideoEncoding({ platform: "linux", commandLine })).toBe(true);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith(
      "enable-features",
      "ExistingFeature,PlatformHEVCEncoderSupport,WebRtcAllowH265Send,WebRtcAllowH265Receive",
    );
    expect(commandLine.appendSwitch).toHaveBeenCalledWith("disable-webrtc-hw-encoding");
    expect(commandLine.appendSwitch).toHaveBeenCalledWith("disable-accelerated-video-encode");
  });

  it("allows an explicit hardware mode without duplicating launcher features", () => {
    const commandLine = {
      getSwitchValue: vi.fn(() => "ExistingFeature,AcceleratedVideoEncoder"),
      appendSwitch: vi.fn(),
    };
    configureLinuxVideoEncoding({ platform: "linux", commandLine, mode: "hardware" });
    expect(commandLine.appendSwitch).toHaveBeenCalledWith(
      "enable-features",
      "ExistingFeature,AcceleratedVideoEncoder,PlatformHEVCEncoderSupport,WebRtcAllowH265Send,WebRtcAllowH265Receive",
    );
    expect(commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-webrtc-hw-encoding");
  });

  it("does nothing outside Linux", () => {
    const commandLine = { getSwitchValue: vi.fn(), appendSwitch: vi.fn() };
    expect(configureLinuxVideoEncoding({ platform: "win32", commandLine })).toBe(false);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("reads and writes a device-local encoder preference", () => {
    const files = new Map();
    const fsImpl = {
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((file) => {
        if (!files.has(file)) throw new Error("missing");
        return files.get(file);
      }),
      writeFileSync: vi.fn((file, value) => files.set(file, value)),
    };
    expect(readLinuxVideoEncoderMode({ platform: "linux", userDataPath: "/profile", fsImpl }))
      .toBe("compatibility");
    expect(writeLinuxVideoEncoderMode("hardware", {
      platform: "linux",
      userDataPath: "/profile",
      fsImpl,
    })).toBe(true);
    expect(readLinuxVideoEncoderMode({ platform: "linux", userDataPath: "/profile", fsImpl }))
      .toBe("hardware");
  });

  it("merges feature lists without duplicates", () => {
    expect(mergeFeatureSwitch("A,B", ["B", "C"])).toBe("A,B,C");
  });
});
