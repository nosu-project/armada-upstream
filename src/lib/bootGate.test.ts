// @vitest-environment jsdom
/**
 * The boot gate's contract: open-by-default under vitest (so suites mounting
 * the gated ingest components see them immediately), reactive when it opens,
 * one-way and idempotent.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { _setBootGateForTests, isBootGateOpen, markBootPainted, useBootGateOpen } from "./bootGate";

afterEach(() => {
  // Restore the vitest default so other suites see the gate open.
  _setBootGateForTests(true);
});

describe("bootGate", () => {
  it("starts open under vitest", () => {
    expect(isBootGateOpen()).toBe(true);
  });

  it("notifies subscribers when the gate opens", () => {
    _setBootGateForTests(false);
    const { result } = renderHook(() => useBootGateOpen());
    expect(result.current).toBe(false);
    act(() => markBootPainted());
    expect(result.current).toBe(true);
  });

  it("is idempotent and one-way", () => {
    _setBootGateForTests(false);
    markBootPainted();
    markBootPainted();
    expect(isBootGateOpen()).toBe(true);
  });
});
