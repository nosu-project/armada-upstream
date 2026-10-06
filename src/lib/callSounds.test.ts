// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = { current: "web" };
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => platform.current } }));

class FakeContext {
  static made: unknown[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  constructor(options?: AudioContextOptions) {
    FakeContext.made.push(options);
  }
  createOscillator() {
    return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (n: unknown) => n };
  }
}

async function contextOptionsOn(name: string) {
  platform.current = name;
  FakeContext.made = [];
  vi.resetModules();
  vi.stubGlobal("AudioContext", FakeContext);
  const { playJoinSound } = await import("./callSounds");
  playJoinSound();
  return FakeContext.made;
}

describe("call sounds' AudioContext", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A shared interactive stream opened by the ring would pin the call's audio to the media stream.
  it("takes the high-latency stream on Android, apart from the call's", async () => {
    expect(await contextOptionsOn("android")).toEqual([{ latencyHint: "playback" }]);
  });

  it("keeps the browser default elsewhere", async () => {
    expect(await contextOptionsOn("web")).toEqual([undefined]);
    expect(await contextOptionsOn("ios")).toEqual([undefined]);
  });
});
