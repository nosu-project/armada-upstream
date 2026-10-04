// @vitest-environment jsdom
import { EventEmitter } from "node:events";

import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keepCallAudioRunning } from "./voiceAudioContext";

class FakeContext extends EventTarget {
  state: AudioContextState = "running";
  resume = vi.fn(async () => {});
  set(state: AudioContextState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function fakeRoom(ctx: FakeContext | undefined) {
  return Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected as ConnectionState,
    audioContext: ctx as unknown,
  });
}

describe("keepCallAudioRunning", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resumes a context the browser suspends mid-call, retrying until it runs", async () => {
    const ctx = new FakeContext();
    const room = fakeRoom(ctx);
    const stop = keepCallAudioRunning(room as unknown as Room);
    expect(ctx.resume).not.toHaveBeenCalled();

    ctx.set("suspended");
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.resume).toHaveBeenCalledTimes(2);

    ctx.set("running");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    stop();
  });

  it("resumes a context WebKit reports as interrupted", () => {
    const ctx = new FakeContext();
    const room = fakeRoom(ctx);
    const stop = keepCallAudioRunning(room as unknown as Room);
    ctx.set("interrupted" as AudioContextState);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    stop();
  });

  it("follows the new context LiveKit creates on reconnect", () => {
    const first = new FakeContext();
    const room = fakeRoom(first);
    const stop = keepCallAudioRunning(room as unknown as Room);

    const second = new FakeContext();
    room.audioContext = second;
    room.emit(RoomEvent.Connected);
    second.set("suspended");
    expect(second.resume).toHaveBeenCalledTimes(1);
    first.set("suspended");
    expect(first.resume).not.toHaveBeenCalled();
    stop();
  });

  it("leaves the context alone while not connected, and after stop", async () => {
    const ctx = new FakeContext();
    const room = fakeRoom(ctx);
    room.state = ConnectionState.Reconnecting;
    const stop = keepCallAudioRunning(room as unknown as Room);
    ctx.set("suspended");
    expect(ctx.resume).not.toHaveBeenCalled();

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event("pointerdown"));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });
});
