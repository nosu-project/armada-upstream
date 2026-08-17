/**
 * `AppProvider` / `useLocalStorage` re-render fan-out.
 *
 * `AppContext` is read by ~67 files, and `NostrProvider` is one of them — so
 * its own value (read by ~96 more, plus everything reaching it through
 * `useCurrentUser`) is invalidated by anything that invalidates this one. Two
 * properties keep that from meaning "the whole app re-renders whenever
 * anything renders":
 *
 * 1. The context value is memoized, so a render of `AppProvider` that did not
 *    move `config` reaches no consumer.
 * 2. `updateConfig` is reference-stable. It appears in ~15 `useEffect` /
 *    `useCallback` dependency arrays across 12 files (`NostrSync`'s relay-list
 *    adoption, `useConfigDocSync`'s apply effect, `useNip65RelaySetup`,
 *    `useTheme`, …), so a setter recreated per render silently re-ran all of
 *    them on every render of their component — the dependency arrays read as
 *    if they were gated, and were not.
 */

import { act, render } from "@testing-library/react";
import { memo, useEffect, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { AppProvider } from "@/components/AppProvider";
import { useAppContext } from "@/hooks/useAppContext";

beforeEach(() => {
  localStorage.clear();
});

/**
 * Renders a consumer under an AppProvider whose PARENT can be re-rendered on
 * demand, and reports what the consumer saw.
 */
function mountHarness() {
  let consumerRenders = 0;
  const updateConfigIdentities = new Set<unknown>();
  let bumpParent: (() => void) | undefined;
  let setFlag: ((on: boolean) => void) | undefined;

  // `memo` with no props isolates CONTEXT propagation from ordinary child
  // re-rendering: React re-renders this only if the context value changed.
  // Without it the harness would measure its own parent re-render, which is
  // not what the memoized provider value is meant to prevent.
  const Consumer = memo(function Consumer() {
    consumerRenders++;
    const { config, updateConfig } = useAppContext();
    updateConfigIdentities.add(updateConfig);
    useEffect(() => {
      setFlag = (on) => updateConfig((c) => ({ ...c, stripTrackingParams: on }));
    }, [updateConfig]);
    return <span>{String(config.stripTrackingParams)}</span>;
  });

  function Harness() {
    const [, setN] = useState(0);
    useEffect(() => {
      bumpParent = () => setN((n) => n + 1);
    }, []);
    return (
      <AppProvider storageKey="rerender-test">
        <Consumer />
      </AppProvider>
    );
  }

  render(<Harness />);
  return {
    consumerRenders: () => consumerRenders,
    identities: () => updateConfigIdentities.size,
    bumpParent: () => act(() => void bumpParent?.()),
    setFlag: (on: boolean) => act(() => void setFlag?.(on)),
  };
}

describe("AppProvider re-render fan-out", () => {
  it("does not re-render consumers when config did not change", async () => {
    const h = mountHarness();
    const baseline = h.consumerRenders();

    for (let i = 0; i < 5; i++) await h.bumpParent();

    // Before the value was memoized this was 1:1 — five parent renders, five
    // consumer renders, with config never touched.
    expect(h.consumerRenders()).toBe(baseline);
  });

  it("keeps updateConfig reference-stable across renders", async () => {
    const h = mountHarness();

    for (let i = 0; i < 5; i++) await h.bumpParent();
    await h.setFlag(false);
    await h.bumpParent();

    // One identity for the life of the hook — including ACROSS a real config
    // write, since `key` is what the setter is bound to, not the value.
    expect(h.identities()).toBe(1);
  });

  it("still re-renders consumers when config actually changes", async () => {
    const h = mountHarness();
    const baseline = h.consumerRenders();

    await h.setFlag(false);

    // The memo must not be so aggressive that a real edit stops propagating.
    expect(h.consumerRenders()).toBeGreaterThan(baseline);
  });
});
