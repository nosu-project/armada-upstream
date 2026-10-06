import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ name: "web" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform.name },
}));

import {
  audioDeviceLabel,
  effectiveAvServers,
  getPreferredMicId,
  micCaptureConstraints,
  platformRoutesCallAudio,
  rememberVoiceDevice,
  getScreenShareVolume,
  getUserVolume,
  getUserVolumes,
  liveDeviceSwitch,
  MAX_PLAYBACK_VOLUME,
  rememberScreenShareVolume,
  rememberUserVolume,
  setPreferredVoiceServer,
  subscribeUserVolumes,
  subscribeVoiceDevices,
} from "@/lib/voiceDevices";

describe("voice server replacement", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses deployment defaults only while no synchronized preference exists", () => {
    expect(effectiveAvServers(["https://armada.example"])).toEqual([
      "https://armada.example",
    ]);
  });

  it("replaces the AV defaults with the custom host", () => {
    setPreferredVoiceServer("https://voice.mine.example/path");
    expect(effectiveAvServers(["https://armada.example"])).toEqual([
      "https://voice.mine.example",
    ]);
  });
});

describe("voice playback volumes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("supports and clamps microphone gain through 200 percent", () => {
    expect(getUserVolume("alice")).toBe(1);

    rememberUserVolume("alice", 1.75);
    expect(getUserVolume("alice")).toBe(1.75);

    rememberUserVolume("alice", 3);
    expect(getUserVolume("alice")).toBe(MAX_PLAYBACK_VOLUME);

    rememberUserVolume("alice", -1);
    expect(getUserVolume("alice")).toBe(0);
  });

  it("stores screen-share gain independently from microphone gain", () => {
    rememberUserVolume("alice", 0.4);
    rememberScreenShareVolume("alice", 1.6);

    expect(getUserVolume("alice")).toBe(0.4);
    expect(getScreenShareVolume("alice")).toBe(1.6);
  });

  it("removes the microphone override when restored to 100 percent", () => {
    rememberUserVolume("alice", 1.5);
    rememberUserVolume("alice", 1);

    expect(getUserVolumes()).toEqual({});
    expect(getUserVolume("alice")).toBe(1);
  });

  it("notifies live controls for microphone and screen-share changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUserVolumes(listener);

    rememberUserVolume("alice", 1.2);
    rememberScreenShareVolume("alice", 0.8);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    rememberUserVolume("alice", 1.3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("audioDeviceLabel", () => {
  const dev = (deviceId: string, label: string) => ({ deviceId, label }) as MediaDeviceInfo;

  it("calls the unlabeled default Automatic", () => {
    expect(audioDeviceLabel(dev("default", ""), "Unnamed device")).toBe("Automatic");
    expect(audioDeviceLabel(dev("a2", "Speakerphone"), "x")).toBe("Speakerphone");
  });

  it("falls back for other unlabeled devices", () => {
    expect(audioDeviceLabel(dev("a3", ""), "Microphone 2")).toBe("Microphone 2");
    expect(audioDeviceLabel(dev("default", "Default - USB Mic"), "x")).toBe("Default - USB Mic");
  });
});

describe("Android call routing", () => {
  beforeEach(() => {
    localStorage.clear();
    platform.name = "web";
  });

  it("leaves the route to the platform only on Android", () => {
    expect(platformRoutesCallAudio()).toBe(false);
    platform.name = "ios";
    expect(platformRoutesCallAudio()).toBe(false);
    platform.name = "android";
    expect(platformRoutesCallAudio()).toBe(true);
  });

  it("ignores a remembered mic on Android, where it may be a stale route pick", () => {
    rememberVoiceDevice("audioinput", "earpiece-id");
    expect(getPreferredMicId()).toBe("earpiece-id");
    expect(micCaptureConstraints().deviceId).toBe("earpiece-id");

    platform.name = "android";
    expect(getPreferredMicId()).toBeUndefined();
    expect(micCaptureConstraints()).not.toHaveProperty("deviceId");
  });
});

describe("live device switching", () => {
  beforeEach(() => {
    localStorage.clear();
    platform.name = "web";
    vi.unstubAllGlobals();
  });

  /** A Chromium-like engine whose AudioContext can pick an output. */
  const stubSpeakerSelection = () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("AudioContext", class { setSinkId() {} });
  };

  it("notifies subscribers of each device choice by kind", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceDevices(listener);

    rememberVoiceDevice("audioinput", "mic-2");
    rememberVoiceDevice("audiooutput", "default");
    expect(listener.mock.calls).toEqual([["audioinput"], ["audiooutput"]]);

    unsubscribe();
    rememberVoiceDevice("audioinput", "mic-3");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("switches the mic only when the room is on a different one", () => {
    expect(liveDeviceSwitch("audioinput", undefined)).toBeUndefined();

    rememberVoiceDevice("audioinput", "mic-2");
    expect(liveDeviceSwitch("audioinput", "mic-1")).toBe("mic-2");
    expect(liveDeviceSwitch("audioinput", "mic-2")).toBeUndefined();

    rememberVoiceDevice("audioinput", "default");
    expect(liveDeviceSwitch("audioinput", "mic-2")).toBe("default");
    expect(liveDeviceSwitch("audioinput", "")).toBeUndefined();
  });

  it("follows the speaker only where the platform can select one", () => {
    rememberVoiceDevice("audiooutput", "speaker-2");
    expect(liveDeviceSwitch("audiooutput", "speaker-1")).toBeUndefined();

    stubSpeakerSelection();
    expect(liveDeviceSwitch("audiooutput", "speaker-1")).toBe("speaker-2");
    expect(liveDeviceSwitch("audiooutput", "speaker-2")).toBeUndefined();
  });

  it("leaves the mic to the platform on Android and never switches cameras", () => {
    rememberVoiceDevice("audioinput", "earpiece-id");
    rememberVoiceDevice("videoinput", "camera-2");
    platform.name = "android";

    expect(liveDeviceSwitch("audioinput", "mic-1")).toBeUndefined();
    expect(liveDeviceSwitch("videoinput", "camera-1")).toBeUndefined();
  });
});
