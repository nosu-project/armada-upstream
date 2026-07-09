import { describe, expect, it } from "vitest";

import { repairDoubledScheme } from "./useUploadFile";

describe("repairDoubledScheme", () => {
  it("collapses a doubled scheme with the second colon missing", () => {
    expect(
      repairDoubledScheme("https://https//blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled scheme with the second colon intact", () => {
    expect(
      repairDoubledScheme("https://https://blossom.dreamith.to/3c25.png"),
    ).toBe("https://blossom.dreamith.to/3c25.png");
  });

  it("collapses a doubled http scheme", () => {
    expect(repairDoubledScheme("http://http//host/x")).toBe("http://host/x");
  });

  it("normalizes the surviving scheme to lowercase", () => {
    expect(repairDoubledScheme("HTTPS://HTTPS//host/x")).toBe("https://host/x");
  });

  it("leaves a well-formed URL untouched", () => {
    expect(repairDoubledScheme("https://blossom.dreamith.to/3c25.png")).toBe(
      "https://blossom.dreamith.to/3c25.png",
    );
  });

  it("does not touch a host that merely starts with the scheme name", () => {
    expect(repairDoubledScheme("https://httpsworld.example/x")).toBe(
      "https://httpsworld.example/x",
    );
  });
});
