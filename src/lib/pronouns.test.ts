import { describe, expect, it } from "vitest";

import { getPronouns, MAX_PRONOUNS_LENGTH } from "@/lib/pronouns";

describe("getPronouns", () => {
  it("reads the trimmed kind-0 field", () => {
    expect(getPronouns({ pronouns: "  they/them " })).toBe("they/them");
  });

  it("is absent when missing, blank or not a string", () => {
    expect(getPronouns(undefined)).toBeUndefined();
    expect(getPronouns({})).toBeUndefined();
    expect(getPronouns({ pronouns: "   " })).toBeUndefined();
    expect(getPronouns({ pronouns: ["she", "her"] })).toBeUndefined();
  });

  it("caps the length", () => {
    expect(getPronouns({ pronouns: "x".repeat(500) })).toHaveLength(MAX_PRONOUNS_LENGTH);
  });
});
