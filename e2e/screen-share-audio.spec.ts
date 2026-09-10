import { expect, test } from "@playwright/test";

// Regression guard for livekit/client-sdk-js#1799: when a screen share is
// started WITH audio, `restrictOwnAudio` must reach the browser's
// getDisplayMedia. Without it, the capture includes the call's own playback —
// other participants' voices out of the sharer's speakers — and republishes it
// as the screen-share audio track, so everyone who spoke hears themselves.
//
// This runs the REAL livekit path in a REAL Chromium (harness.ts drives
// `setScreenShareEnabled` → `createScreenTracks` →
// `screenCaptureToDisplayMediaStreamOptions` → getDisplayMedia). That is the
// one place the SDK strips the flag today and the one place a future SDK bump
// could silently re-break it — a vitest test that mocks around the SDK cannot
// see either. The harness records the constraints getDisplayMedia was actually
// called with; we assert the flag survived the whole path to the boundary AND
// landed where the browser reads it: inside the audio track constraints. A
// top-level member is silently ignored, so checking placement — not mere
// presence — is what keeps this honest.
test("restrictOwnAudio reaches getDisplayMedia on an audio screen share", async ({
  page,
}) => {
  await page.goto("/e2e/harness.html");
  await page.waitForFunction(() => Boolean(window.__screenShareHarness));

  const recorded = await page.evaluate(() =>
    window.__screenShareHarness!.startShare(),
  );

  // The capture ran and asked for audio (the precondition for the echo)...
  expect(recorded).toHaveLength(1);
  const audio = recorded[0].audio;
  expect(typeof audio).toBe("object");
  // ...and the own-audio restriction rode on the audio track, where the browser
  // honors it — not the top level, which it drops.
  expect((audio as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBe(true);
  // Chrome refuses that restriction below Windows 11, so the web build also
  // asks for the display-audio echo canceller, whose reference is this page's
  // own call playout.
  expect((audio as MediaTrackConstraints).echoCancellation).toBe(true);
});
