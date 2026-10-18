import { describe, expect, it } from "vitest";

import {
  EMPTY_SEARCH_FILTERS,
  activeFacetCount,
  dateTokenPatch,
  parseSearchDate,
  removeToken,
  resolveTypedTokens,
  searchDateBounds,
  searchIsActive,
  searchText,
  shiftYmd,
  tokenAtCaret,
} from "./search";

describe("tokenAtCaret", () => {
  it("splits a known key from its value", () => {
    expect(tokenAtCaret("hello from:al", 13)).toEqual({ start: 6, end: 13, key: "from", value: "al" });
  });

  it("takes the whole word around a mid-word caret", () => {
    expect(tokenAtCaret("in:gen x", 4)).toEqual({ start: 0, end: 6, key: "in", value: "gen" });
  });

  it("leaves an unknown key and a plain word bare", () => {
    expect(tokenAtCaret("re:meeting", 10)).toEqual({ start: 0, end: 10, value: "re:meeting" });
    expect(tokenAtCaret("fr", 2)).toEqual({ start: 0, end: 2, value: "fr" });
  });

  it("is an empty bare word after a space", () => {
    expect(tokenAtCaret("cats ", 5)).toEqual({ start: 5, end: 5, value: "" });
  });
});

describe("searchText", () => {
  it("drops known filter tokens but keeps other colons", () => {
    expect(searchText("cats from:al  in:gen re:meeting")).toBe("cats re:meeting");
    expect(searchIsActive({ ...EMPTY_SEARCH_FILTERS, query: "from:al" })).toBe(false);
  });
});

describe("resolveTypedTokens", () => {
  const now = new Date(2026, 9, 17, 15, 0, 0);

  it("folds finished has:/date tokens into facets", () => {
    const f = resolveTypedTokens({ ...EMPTY_SEARCH_FILTERS, query: "cats has:images during:today dogs" }, now);
    expect(f).toMatchObject({ query: "cats dogs", media: "images", dateFrom: "2026-10-17", dateTo: "2026-10-17" });
  });

  it("leaves the token being typed, unknown values and from:/in:", () => {
    const q = "has:imag has:nope from:al after:2026";
    expect(resolveTypedTokens({ ...EMPTY_SEARCH_FILTERS, query: q }, now).query).toBe(q);
  });
});

describe("removeToken", () => {
  it("keeps one space at the seam", () => {
    expect(removeToken("cats from:al dogs", 5, 12)).toBe("cats dogs");
    expect(removeToken("from:al dogs", 0, 7)).toBe("dogs");
    expect(removeToken("cats has:image", 5, 14)).toBe("cats");
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 17, 15, 0, 0);

  it("parses today, yesterday and ISO days, rejecting rollovers", () => {
    expect(parseSearchDate("today", now)).toBe("2026-10-17");
    expect(parseSearchDate("Yesterday", now)).toBe("2026-10-16");
    expect(parseSearchDate("2026-3-1", now)).toBe("2026-03-01");
    expect(parseSearchDate("2026-02-31", now)).toBeNull();
    expect(parseSearchDate("soon", now)).toBeNull();
  });

  it("shifts across month and year ends", () => {
    expect(shiftYmd("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftYmd("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("makes before/after exclusive and during one whole day", () => {
    expect(dateTokenPatch("before", "2026-10-17")).toEqual({ dateTo: "2026-10-16" });
    expect(dateTokenPatch("after", "2026-10-17")).toEqual({ dateFrom: "2026-10-18" });
    expect(dateTokenPatch("during", "2026-10-17")).toEqual({ dateFrom: "2026-10-17", dateTo: "2026-10-17" });
  });

  it("bounds a range by whole local days", () => {
    const { since, until } = searchDateBounds({ dateFrom: "2026-10-17", dateTo: "2026-10-17" });
    expect(since).toBe(new Date(2026, 9, 17).getTime() / 1000);
    expect(until).toBe(new Date(2026, 9, 18).getTime() / 1000 - 1);
    expect(searchDateBounds({ dateFrom: "", dateTo: "" })).toEqual({});
  });

  it("activates a search and counts as one facet", () => {
    const f = { ...EMPTY_SEARCH_FILTERS, dateFrom: "2026-10-01", dateTo: "2026-10-17" };
    expect(searchIsActive(f)).toBe(true);
    expect(activeFacetCount(f)).toBe(1);
  });
});
