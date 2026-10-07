// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Room, RoomEvent } from "livekit-client";

import { keepCallAudioOutput } from "@/lib/voiceAudioContext";
import { preferredAudioOutput, rememberVoiceDevice } from "@/lib/voiceDevices";

/** Chromium-like context that records every sink it is pointed at. */
const sinkCalls: string[] = [];
class RecordingAudioContext {
  state = "running";
  setSinkId(id: string) {
    sinkCalls.push(id);
    return Promise.resolve();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
}

type Internals = { audioContext?: RecordingAudioContext; acquireAudioContext(): Promise<void> };
const internals = (room: Room) => room as unknown as Internals;

const g = globalThis as unknown as { AudioContext?: unknown };
const originalAudioContext = g.AudioContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sinkCalls.length = 0;
  localStorage.clear();
  g.AudioContext = RecordingAudioContext;
});
afterEach(() => {
  if (originalAudioContext === undefined) delete g.AudioContext;
  else g.AudioContext = originalAudioContext;
});

describe("preferredAudioOutput()", () => {
  it("is the remembered speaker", () => {
    rememberVoiceDevice("audiooutput", "usb-headphones");
    expect(preferredAudioOutput()).toEqual({ deviceId: "usb-headphones" });
  });

  it("is undefined with no preference", () => {
    rememberVoiceDevice("audiooutput", "default");
    expect(preferredAudioOutput()).toBeUndefined();
  });

  it("is undefined where the call's AudioContext cannot switch sinks", () => {
    rememberVoiceDevice("audiooutput", "usb-headphones");
    g.AudioContext = class {};
    expect(preferredAudioOutput()).toBeUndefined();
  });
});

describe("keepCallAudioOutput()", () => {
  /** A call room as the app builds it, after connect() has created its context. */
  async function connectedRoom(): Promise<Room> {
    const room = new Room({ webAudioMix: true, audioOutput: preferredAudioOutput() });
    await flush();
    await internals(room).acquireAudioContext();
    return room;
  }

  it("points the connect-time context at the remembered speaker", async () => {
    rememberVoiceDevice("audiooutput", "usb-headphones");
    const room = await connectedRoom();
    expect(sinkCalls).toEqual([]);

    const stop = keepCallAudioOutput(room);
    room.emit(RoomEvent.Connected);
    await flush();
    expect(sinkCalls).toEqual(["usb-headphones"]);
    expect(room.getActiveDevice("audiooutput")).toBe("usb-headphones");
    stop();
  });

  it("re-applies only to a replaced context, following an in-call pick", async () => {
    rememberVoiceDevice("audiooutput", "usb-headphones");
    const room = await connectedRoom();
    const stop = keepCallAudioOutput(room);
    await flush();
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(sinkCalls).toEqual(["usb-headphones"]);

    await room.switchActiveDevice("audiooutput", "hdmi");
    await internals(room).audioContext?.close();
    await internals(room).acquireAudioContext();
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(sinkCalls).toEqual(["usb-headphones", "hdmi", "hdmi"]);
    stop();
  });

  it("leaves the default sink alone with no preference", async () => {
    const room = await connectedRoom();
    const stop = keepCallAudioOutput(room);
    room.emit(RoomEvent.Connected);
    await flush();
    expect(sinkCalls).toEqual([]);
    stop();
  });
});
