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
// called with; we assert the flag survived the whole path to the boundary.
test("restrictOwnAudio reaches getDisplayMedia on an audio screen share", async ({
  page,
}) => {
  await page.goto("/e2e/harness.html");
  await page.waitForFunction(() => Boolean(window.__screenShareHarness));

  const recorded = await page.evaluate(() =>
    window.__screenShareHarness!.startShare(),
  );

  // The capture ran and asked for audio (the precondition for the echo).
  expect(recorded).toHaveLength(1);
  expect(recorded[0].audio).toBeTruthy();
  // The fix: the own-audio restriction was forwarded to the browser.
  expect(recorded[0].restrictOwnAudio).toBe(true);
});
