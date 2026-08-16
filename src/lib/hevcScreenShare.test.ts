import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Track, type Participant } from "livekit-client";
import { describe, expect, it, vi } from "vitest";

import {
  ARMADA_HEVC_SCREEN_SHARE_TRACK,
  HevcScreenShareSessionTracker,
  isHevcScreenShareParticipant,
  stopHevcCapturedMedia,
} from "@/lib/hevcScreenShare";

describe("custom H.265 screen-share participants", () => {
  it("names the track the Go publisher actually publishes", () => {
    // The only thing tying the sidecar to its presenter is this string, and it
    // is written down once in TypeScript and once in Go. A rename on either
    // side makes every roster show the presenter twice, with a join chime for
    // their own screen share, and nothing else would notice.
    const publisher = readFileSync(
      resolve(process.cwd(), "electron/hevc-publisher/main.go"),
      "utf8",
    );

    expect(publisher).toContain(`Name:        ${JSON.stringify(ARMADA_HEVC_SCREEN_SHARE_TRACK)}`);
  });

  it("recognizes a sidecar only from its verified signed identity role", () => {
    const publication = { source: Track.Source.ScreenShare, kind: Track.Kind.Video };
    const participant = {
      identity: "hevc-id",
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      trackPublications: new Map([["screen", publication]]),
      getTrackPublicationByName: vi.fn(() => publication),
    } as unknown as Participant;
    const resolve = vi.fn(() => ({
      pubkey: "a".repeat(64),
      verified: true,
      role: "screen-share" as const,
    }));

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(true);
    expect(resolve).toHaveBeenCalledWith("hevc-id");
  });

  it("does not let an ordinary verified participant hide by spoofing the track name", () => {
    const participant = {
      identity: "member-id",
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      trackPublications: new Map([[
        "screen",
        { source: Track.Source.ScreenShare, kind: Track.Kind.Video },
      ]]),
      getTrackPublicationByName: vi.fn((name: string) =>
        name === ARMADA_HEVC_SCREEN_SHARE_TRACK
          ? { source: Track.Source.ScreenShare, kind: Track.Kind.Video }
          : undefined),
    } as unknown as Participant;
    const resolve = vi.fn(() => ({
      pubkey: "a".repeat(64),
      verified: true,
      role: "member" as const,
    }));

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(false);
  });

  it("does not trust a named track before its identity claim is verified", () => {
    const participant = {
      identity: "unverified-id",
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      trackPublications: new Map(),
      getTrackPublicationByName: vi.fn(() => ({
        source: Track.Source.ScreenShare,
        kind: Track.Kind.Video,
      })),
    } as unknown as Participant;
    const resolve = vi.fn(() => ({
      pubkey: "unverified-id",
      verified: false,
      role: "screen-share" as const,
    }));

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(false);
  });

  it("does not hide a role-claimed participant carrying ordinary media", () => {
    const expected = { source: Track.Source.ScreenShare, kind: Track.Kind.Video };
    const camera = { source: Track.Source.Camera, kind: Track.Kind.Video };
    const resolve = vi.fn(() => ({
      pubkey: "a".repeat(64),
      verified: true,
      role: "screen-share" as const,
    }));
    const participant = {
      identity: "mixed-id",
      isMicrophoneEnabled: false,
      isCameraEnabled: true,
      trackPublications: new Map([
        ["screen", expected],
        ["camera", camera],
      ]),
      getTrackPublicationByName: vi.fn(() => expected),
    } as unknown as Participant;

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(false);
  });

  it("requires the expected named publication to be the only track", () => {
    const expected = { source: Track.Source.ScreenShare, kind: Track.Kind.Video };
    const extra = { source: Track.Source.Unknown, kind: Track.Kind.Video };
    const resolve = vi.fn(() => ({
      pubkey: "a".repeat(64),
      verified: true,
      role: "screen-share" as const,
    }));
    const participant = {
      identity: "mixed-id",
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      trackPublications: new Map([
        ["screen", expected],
        ["extra", extra],
      ]),
      getTrackPublicationByName: vi.fn(() => expected),
    } as unknown as Participant;

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(false);
  });

  it("does not hide a named screen-source audio publication", () => {
    const audio = { source: Track.Source.ScreenShare, kind: Track.Kind.Audio };
    const resolve = vi.fn(() => ({
      pubkey: "a".repeat(64),
      verified: true,
      role: "screen-share" as const,
    }));
    const participant = {
      identity: "audio-spoof",
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      trackPublications: new Map([["audio", audio]]),
      getTrackPublicationByName: vi.fn(() => audio),
    } as unknown as Participant;

    expect(isHevcScreenShareParticipant(participant, resolve)).toBe(false);
  });
});

describe("H.265 local cleanup", () => {
  it("stops every capture track even when one track wrapper throws", () => {
    const first = { stop: vi.fn(() => { throw new Error("already gone"); }) };
    const second = { stop: vi.fn() };
    const stream = {
      getTracks: () => [first, second],
    } as unknown as MediaStream;

    expect(() => stopHevcCapturedMedia(stream)).not.toThrow();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});

describe("H.265 shell session correlation", () => {
  it("ignores a delayed terminal event from a retired session after replacement", () => {
    const sessions = new HevcScreenShareSessionTracker();
    expect(sessions.bind("old-session")).toBe(true);
    sessions.retire();

    expect(sessions.accept({
      state: "starting",
      active: true,
      sessionId: "new-session",
    }, true)).toBe(true);
    expect(sessions.current).toBe("new-session");
    expect(sessions.accept({
      state: "stopped",
      active: false,
      sessionId: "old-session",
    }, true)).toBe(false);
    expect(sessions.current).toBe("new-session");
    expect(sessions.accept({
      state: "published",
      active: true,
      sessionId: "new-session",
    }, true)).toBe(true);
  });

  it("rejects terminal events that cannot name the active session", () => {
    const sessions = new HevcScreenShareSessionTracker();

    expect(sessions.accept({ state: "stopped", active: false }, true)).toBe(false);
    expect(sessions.accept({
      state: "error",
      active: false,
      sessionId: "unknown-session",
    }, true)).toBe(false);
    expect(sessions.accept({ state: "idle", active: false }, true)).toBe(false);
  });
});
