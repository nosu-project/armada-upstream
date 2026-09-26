import { describe, expect, it } from "vitest";

import { MAX_INPUT_BYTES } from "@/lib/video/policy";

import { MAX_ENCRYPTED_BYTES, deviceInputLimit, keepUserFields, mimeOfPicked } from "./attachmentLimits";

const URL = "https://blossom.example/abc.jpg";

describe("deviceInputLimit", () => {
  it("bounds nothing on an unencrypted upload — that is the server's call", () => {
    for (const mime of ["video/mp4", "image/jpeg", "audio/ogg", "application/pdf", ""]) {
      expect(deviceInputLimit(mime, false), mime).toBeUndefined();
    }
  });

  it("lets an encrypted video in past the sealing limit, since the transcode brings it under", () => {
    expect(deviceInputLimit("video/mp4", true)).toBe(MAX_INPUT_BYTES);
    expect(MAX_INPUT_BYTES).toBeGreaterThan(MAX_ENCRYPTED_BYTES);
  });

  it("holds everything else encrypted to the sealing limit as picked", () => {
    for (const mime of ["image/jpeg", "audio/ogg", "application/pdf", ""]) {
      expect(deviceInputLimit(mime, true), mime).toBe(MAX_ENCRYPTED_BYTES);
    }
  });
});

describe("mimeOfPicked", () => {
  it("falls back to the extension when the type is empty", () => {
    expect(mimeOfPicked("clip.avi", "")).toMatch(/^video\//);
    expect(mimeOfPicked("clip.avi", "application/x-thing")).toBe("application/x-thing");
  });
});

describe("keepUserFields", () => {
  it("keeps a description and spoiler the user set when the same file lands again", () => {
    const existing = [["url", URL], ["m", "image/jpeg"], ["alt", "A cat"], ["content-warning", "spoiler"]];
    const next = [["url", URL], ["m", "image/jpeg"], ["dim", "10x10"]];
    expect(keepUserFields(existing, next)).toEqual([...next, ["alt", "A cat"], ["content-warning", "spoiler"]]);
  });

  it("lets the new upload's own value win where it has one", () => {
    const existing = [["url", URL], ["content-warning", "spoiler"]];
    const next = [["url", URL], ["content-warning", "plot"]];
    expect(keepUserFields(existing, next)).toEqual(next);
  });

  it("is the upload unchanged for a new URL", () => {
    const next = [["url", URL]];
    expect(keepUserFields(undefined, next)).toBe(next);
  });
});
