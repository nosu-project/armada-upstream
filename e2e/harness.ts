// Browser-side harness for the screen-share audio e2e. It drives the REAL
// livekit-client screen-capture path (`setScreenShareEnabled` →
// `createScreenTracks` → `screenCaptureToDisplayMediaStreamOptions` →
// `getDisplayMedia`) so the spec proves the `restrictOwnAudio` flag survives
// all the way to the browser boundary — the exact place the SDK drops it
// (livekit/client-sdk-js#1799) and the exact thing a future SDK bump could
// silently re-break. A pure-vitest test mocks around the SDK and cannot.
//
// It needs no signalling connection: `setScreenShareEnabled` calls
// `getDisplayMedia` before it publishes, so the capture is recorded and only
// the later publish (which needs an engine) rejects, which we swallow.
import { Room } from "livekit-client";

import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  screenShareCaptureOptions,
} from "@/lib/screenShareQuality";

interface DisplayMediaWithRestrict extends DisplayMediaStreamOptions {
  restrictOwnAudio?: boolean;
}

interface ScreenShareHarness {
  startShare(): Promise<DisplayMediaWithRestrict[]>;
}

declare global {
  interface Window {
    __screenShareHarness?: ScreenShareHarness;
  }
}

const recorded: DisplayMediaWithRestrict[] = [];

// The downstream capture: record the constraints `getDisplayMedia` is actually
// called with, and hand back a synthetic surface with a video track so
// `createScreenTracks` doesn't throw `no video track found`. Installed BEFORE
// the app wrapper so, once the wrapper exists, it binds this recorder as its
// own `original` — which is what lets us observe what the wrapper forwarded.
function installRecorder(): void {
  const base = async (
    constraints?: DisplayMediaStreamOptions,
  ): Promise<MediaStream> => {
    recorded.push((constraints ?? {}) as DisplayMediaWithRestrict);
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    return (
      canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
    ).captureStream(1);
  };
  navigator.mediaDevices.getDisplayMedia = base as MediaDevices["getDisplayMedia"];
}

async function main(): Promise<void> {
  installRecorder();

  // Install the production wrapper if it exists yet. A tolerated absence is
  // what keeps this spec red before the fix (no flag injected) and green after,
  // purely on the flag reaching the boundary rather than on an import name.
  try {
    const mod = await import("@/lib/screenShareAudioRestriction");
    mod.installScreenShareAudioRestriction();
  } catch {
    // Not implemented — the recorder stays the live getDisplayMedia.
  }

  window.__screenShareHarness = {
    async startShare() {
      recorded.length = 0;
      const room = new Room();
      try {
        await room.localParticipant.setScreenShareEnabled(
          true,
          screenShareCaptureOptions(DEFAULT_SCREEN_SHARE_QUALITY),
        );
      } catch {
        // No signalling connection, so publishing rejects — but getDisplayMedia
        // has already run and recorded its constraints, which is all we assert.
      }
      return recorded.slice();
    },
  };
}

void main();
