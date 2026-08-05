import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getScreenShareVolume,
  getUserVolume,
  getUserVolumes,
  MAX_PLAYBACK_VOLUME,
  rememberScreenShareVolume,
  rememberUserVolume,
  subscribeUserVolumes,
} from "@/lib/voiceDevices";

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
