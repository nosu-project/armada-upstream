/**
 * `DateTimePicker` date-mode round-trip.
 *
 * An all-day (`mode="date"`) value is a `YYYY-MM-DD` string with no zone. It is
 * displayed with local getters (`toDateString`/`formatLabel`), so the string
 * must be parsed as LOCAL midnight — parsing it as UTC midnight (`new Date(
 * "2026-09-10")`) put the displayed day one behind for any user west of UTC,
 * while the string that got posted was correct. This pins the parse so the day
 * shown equals the day stored.
 */

// Force a negative-offset zone before any Date is constructed — the bug is
// invisible at UTC. V8 re-reads process.env.TZ per operation, so setting it at
// module top-level covers the dates built at render time.
process.env.TZ = "America/New_York";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DateTimePicker } from "@/components/ui/date-time-picker";

describe("DateTimePicker date mode", () => {
  it("shows the same day it was given, west of UTC", () => {
    render(<DateTimePicker mode="date" value="2026-09-10" onChange={() => {}} />);
    // "Thu, Sep 10, 2026" — not Sep 9.
    expect(screen.getByText(/Sep 10, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Sep 9, 2026/)).not.toBeInTheDocument();
  });
});
