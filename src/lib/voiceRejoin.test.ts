import { EventEmitter } from "node:events";

import { DisconnectReason, ParticipantEvent, Track, type Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";

import { isRecoverableDisconnect, rejoinRoom, trackMicIntent } from "./voiceRejoin";

function fakeRoom(connect: () => Promise<void>) {
  const lp = Object.assign(new EventEmitter(), {
    isMicrophoneEnabled: false,
    setMicrophoneEnabled: vi.fn(async (on: boolean) => {
      lp.isMicrophoneEnabled = on;
    }),
  });
  const room = Object.assign(new EventEmitter(), {
    localParticipant: lp,
    connect: vi.fn(connect),
  });
  return { room: room as unknown as Room, lp };
}

/** A clock the fake sleep advances, so backoff runs instantly. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("isRecoverableDisconnect", () => {
  it("rejoins dropped connections and stays down when told to", () => {
    expect(isRecoverableDisconnect(undefined)).toBe(true);
    expect(isRecoverableDisconnect(DisconnectReason.STATE_MISMATCH)).toBe(true);
    expect(isRecoverableDisconnect(DisconnectReason.SIGNAL_CLOSE)).toBe(true);
    expect(isRecoverableDisconnect(DisconnectReason.JOIN_FAILURE)).toBe(true);
    expect(isRecoverableDisconnect(DisconnectReason.UNKNOWN_REASON)).toBe(true);
    expect(isRecoverableDisconnect(DisconnectReason.CLIENT_INITIATED)).toBe(false);
    expect(isRecoverableDisconnect(DisconnectReason.DUPLICATE_IDENTITY)).toBe(false);
    expect(isRecoverableDisconnect(DisconnectReason.PARTICIPANT_REMOVED)).toBe(false);
    expect(isRecoverableDisconnect(DisconnectReason.ROOM_DELETED)).toBe(false);
  });
});

describe("rejoinRoom", () => {
  it("retries until the SFU takes us back, then republishes a live mic", async () => {
    let calls = 0;
    const { room, lp } = fakeRoom(async () => {
      if (++calls < 3) throw new Error("Failed to fetch");
    });
    const c = clock();
    const ok = await rejoinRoom(room, "wss://sfu", "tok", {
      signal: new AbortController().signal,
      micWanted: () => true,
      ...c,
    });
    expect(ok).toBe(true);
    expect(room.connect).toHaveBeenCalledTimes(3);
    expect(room.connect).toHaveBeenCalledWith("wss://sfu", "tok");
    expect(lp.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("leaves a muted user muted", async () => {
    const { room, lp } = fakeRoom(async () => {});
    await rejoinRoom(room, "wss://sfu", "tok", {
      signal: new AbortController().signal,
      micWanted: () => false,
      ...clock(),
    });
    expect(lp.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("waits for the network instead of burning attempts while offline", async () => {
    const { room } = fakeRoom(async () => {});
    let online = false;
    const ok = await rejoinRoom(room, "wss://sfu", "tok", {
      signal: new AbortController().signal,
      micWanted: () => false,
      ...clock(),
      isOnline: () => online,
      waitOnline: async () => {
        online = true;
      },
    });
    expect(ok).toBe(true);
    expect(room.connect).toHaveBeenCalledTimes(1);
  });

  it("gives up when the window runs out", async () => {
    const { room } = fakeRoom(async () => {
      throw new Error("Failed to fetch");
    });
    const ok = await rejoinRoom(room, "wss://sfu", "tok", {
      signal: new AbortController().signal,
      micWanted: () => false,
      windowMs: 30_000,
      ...clock(),
    });
    expect(ok).toBe(false);
    expect(vi.mocked(room.connect).mock.calls.length).toBeGreaterThan(2);
  });

  it("stops when the call is left mid-rejoin", async () => {
    const ctrl = new AbortController();
    const { room } = fakeRoom(async () => {
      ctrl.abort();
      throw new Error("Failed to fetch");
    });
    const ok = await rejoinRoom(room, "wss://sfu", "tok", { signal: ctrl.signal, micWanted: () => true, ...clock() });
    expect(ok).toBe(false);
    expect(room.connect).toHaveBeenCalledTimes(1);
  });
});

describe("trackMicIntent", () => {
  it("ignores the unpublish a dropping connection performs", () => {
    const { room, lp } = fakeRoom(async () => {});
    const intent = trackMicIntent(room);
    lp.emit(ParticipantEvent.LocalTrackPublished, { source: Track.Source.Microphone, isMuted: false });
    expect(intent.wanted()).toBe(true);

    // LiveKit unpublishes while still reporting Connected.
    lp.emit(ParticipantEvent.LocalTrackUnpublished, { source: Track.Source.Microphone });
    expect(intent.wanted()).toBe(true);

    lp.emit(ParticipantEvent.TrackMuted, { source: Track.Source.Microphone });
    expect(intent.wanted()).toBe(false);
    lp.emit(ParticipantEvent.TrackUnmuted, { source: Track.Source.Microphone, isMuted: false });
    expect(intent.wanted()).toBe(true);
    lp.emit(ParticipantEvent.TrackMuted, { source: Track.Source.Camera });
    expect(intent.wanted()).toBe(true);
    intent.dispose();
  });
});
