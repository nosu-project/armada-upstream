import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

// The recorder end to end in a real Chromium: worklet taps on one clock, the
// worker's timeline, OPFS staging, and every encoder (Opus through WebCodecs).
// The WAV run is decoded here to check the property a podcast edit depends on —
// separate voices that line up — and the one privacy depends on: a voice the
// policy drops is silent from that moment on.

test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

const RATE = 48_000;

function wavSamples(bytes: Buffer): Float64Array {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  const dataBytes = bytes.readUInt32LE(40);
  const out = new Float64Array(dataBytes / 3);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readIntLE(44 + i * 3, 3) / 8_388_607;
  return out;
}

/** RMS of `samples` between two times, in seconds. */
function rms(samples: Float64Array, from: number, to: number): number {
  const a = Math.floor(from * RATE);
  const b = Math.min(samples.length, Math.floor(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, b - a));
}

test("records each voice to its own aligned file and drops a voice the moment it's refused", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/callRecording.html");
  await page.waitForFunction(() => Boolean(window.__callRecordingHarness));

  // Ana alone, then Ben joins, then Ana refuses.
  const files = await page.evaluate(() =>
    window.__callRecordingHarness!.record("wav", "multichannel", [
      { ms: 800, voices: ["ana"] },
      { ms: 800, voices: ["ana", "ben"] },
      { ms: 800, voices: ["ben"] },
    ]),
  );

  expect(files.map((f) => f.key).sort()).toEqual(["ana", "ben"]);
  const ana = wavSamples(Buffer.from(files.find((f) => f.key === "ana")!.base64, "base64"));
  const ben = wavSamples(Buffer.from(files.find((f) => f.key === "ben")!.base64, "base64"));
  for (const f of files) writeFileSync(testInfo.outputPath(`${f.key}.wav`), Buffer.from(f.base64, "base64"));

  // Both files span the whole take, sample for sample.
  expect(ana.length).toBe(ben.length);
  expect(ana.length / RATE).toBeGreaterThan(2.2);

  // Margins keep each window clear of the phase boundaries' timer jitter.
  expect(rms(ana, 0.1, 0.7)).toBeGreaterThan(0.2);
  expect(rms(ben, 0.1, 0.7)).toBeLessThan(0.001); // not here yet: padded silence
  expect(rms(ana, 0.9, 1.5)).toBeGreaterThan(0.2);
  expect(rms(ben, 0.9, 1.5)).toBeGreaterThan(0.2);
  expect(rms(ana, 1.75, 2.3)).toBeLessThan(0.001); // refused: nothing captured
  expect(rms(ben, 1.75, 2.3)).toBeGreaterThan(0.2);
});

test("writes FLAC, Opus, AU and a mixdown", async ({ page }, testInfo) => {
  await page.goto("/e2e/callRecording.html");
  await page.waitForFunction(() => Boolean(window.__callRecordingHarness));
  const phases = [{ ms: 600, voices: ["ana", "ben"] as ("ana" | "ben")[] }];

  for (const [format, magic] of [
    ["flac", "fLaC"],
    ["opus", "OggS"],
    ["au", ".snd"],
  ] as const) {
    const files = await page.evaluate(
      ({ format, phases }) => window.__callRecordingHarness!.record(format, "multichannel", phases),
      { format, phases },
    );
    expect(files).toHaveLength(2);
    for (const f of files) {
      const bytes = Buffer.from(f.base64, "base64");
      writeFileSync(testInfo.outputPath(`${f.key}.${format}`), bytes);
      expect(bytes.toString("latin1", 0, 4)).toBe(magic);
      if (format === "opus") expect(bytes.includes(Buffer.from("OpusHead"))).toBe(true);
    }
  }

  const mixed = await page.evaluate(
    ({ phases }) => window.__callRecordingHarness!.record("wav", "mixdown", phases),
    { phases },
  );
  expect(mixed.map((f) => f.title)).toEqual(["Mixdown"]);
  const samples = wavSamples(Buffer.from(mixed[0].base64, "base64"));
  expect(rms(samples, 0.1, 0.5)).toBeGreaterThan(0.3);
});
