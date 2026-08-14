import { Track, type Participant } from "livekit-client";

import type { VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";
import type { DesktopHevcScreenShareStatus } from "@/lib/desktop";

/** Track name emitted by Armada's auxiliary Linux HEVC publisher. */
export const ARMADA_HEVC_SCREEN_SHARE_TRACK = "Armada H.265 screen share";

/** Stop every local capture track even if one browser wrapper throws. */
export function stopHevcCapturedMedia(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue stopping every sibling track.
    }
  }
}

/**
 * The custom encoder connects as a second LiveKit participant because the
 * server SDK owns its encoded track. It is media belonging to the presenter,
 * not another caller, and must be omitted from rosters/mute/join reporting.
 */
export function isHevcScreenShareParticipant(
  participant: Participant,
  resolveIdentity: VoiceIdentityResolver,
): boolean {
  const identity = resolveIdentity(participant.identity);
  if (!identity.verified || identity.role !== "screen-share") return false;
  const expected = participant.getTrackPublicationByName?.(ARMADA_HEVC_SCREEN_SHARE_TRACK);
  if (
    !expected ||
    expected.source !== Track.Source.ScreenShare ||
    expected.kind !== Track.Kind.Video
  ) return false;
  if (participant.isMicrophoneEnabled || participant.isCameraEnabled) return false;
  const publications = [...participant.trackPublications.values()];
  return publications.length === 1 && publications[0] === expected;
}

/**
 * Correlates asynchronous shell status events with the one renderer capture
 * that owns them. Retired IDs stay rejected after a replacement begins, so a
 * delayed `stopped`/`error` from the prior process cannot cancel its successor.
 */
export class HevcScreenShareSessionTracker {
  private activeSessionId: string | null = null;
  private readonly retiredSessionIds = new Set<string>();

  get current(): string | null {
    return this.activeSessionId;
  }

  bind(sessionId: string | null | undefined): boolean {
    if (!sessionId || this.retiredSessionIds.has(sessionId)) return false;
    if (this.activeSessionId && this.activeSessionId !== sessionId) return false;
    this.activeSessionId = sessionId;
    return true;
  }

  retire(sessionId: string | null | undefined = this.activeSessionId): void {
    if (!sessionId) return;
    this.retiredSessionIds.add(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }

  accept(status: DesktopHevcScreenShareStatus, captureActive: boolean): boolean {
    const sessionId = status.sessionId;
    if (sessionId && this.retiredSessionIds.has(sessionId)) return false;

    const publishing =
      status.active && (status.state === "starting" || status.state === "published");
    if (!this.activeSessionId && sessionId && publishing && captureActive) {
      this.activeSessionId = sessionId;
    }
    if (sessionId && this.activeSessionId && sessionId !== this.activeSessionId) return false;

    const terminal = status.state === "error" || status.state === "stopped";
    if (terminal) {
      // Terminal events must name the active session. An uncorrelated terminal
      // event is necessarily stale or from a shell older than session IDs.
      return Boolean(sessionId && sessionId === this.activeSessionId);
    }
    if (!sessionId && captureActive) return false;
    if (sessionId && !this.activeSessionId) return false;
    return true;
  }
}
