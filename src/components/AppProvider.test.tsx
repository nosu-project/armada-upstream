/**
 * `AppProvider` reads a PER-ACCOUNT config blob.
 *
 * The helpers are pinned in `lib/activeAccount.test.ts`; what this covers is
 * the wiring, which is where the leak actually lived — one `storageKey` prop,
 * shared by every account on the device, holding the DM peer maps and the rail
 * arrangement.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppProvider } from "@/components/AppProvider";
import { useAppContext } from "@/hooks/useAppContext";
import {
  APP_CONFIG_STORAGE_KEY,
  accountScopedKey,
  setActivePubkey,
  _resetActiveAccountForTests,
} from "@/lib/activeAccount";

const A = "a".repeat(64);
const B = "b".repeat(64);

function ShowConfig() {
  const { config } = useAppContext();
  return (
    <>
      <span data-testid="theme">{config.theme}</span>
      <span data-testid="started">{(config.startedDms ?? []).join(",")}</span>
    </>
  );
}

const renderProvider = () =>
  render(
    <AppProvider storageKey={APP_CONFIG_STORAGE_KEY}>
      <ShowConfig />
    </AppProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
});

afterEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
});

describe("AppProvider config scoping", () => {
  it("reads the active account's blob", () => {
    localStorage.setItem(
      accountScopedKey(APP_CONFIG_STORAGE_KEY, A),
      JSON.stringify({ theme: "light", startedDms: ["peerOfA"] }),
    );
    setActivePubkey(A);

    renderProvider();

    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    expect(screen.getByTestId("started")).toHaveTextContent("peerOfA");
  });

  // The leak, stated directly: B must not see A's DM peers.
  it("does not read another account's blob", () => {
    localStorage.setItem(
      accountScopedKey(APP_CONFIG_STORAGE_KEY, A),
      JSON.stringify({ theme: "light", startedDms: ["peerOfA"] }),
    );
    setActivePubkey(B);

    renderProvider();

    expect(screen.getByTestId("started")).toHaveTextContent("");
    expect(screen.getByTestId("theme")).not.toHaveTextContent("light");
  });

  it("hands the pre-scoping blob to the first account only", () => {
    localStorage.setItem(
      APP_CONFIG_STORAGE_KEY,
      JSON.stringify({ theme: "light", startedDms: ["legacyPeer"] }),
    );

    setActivePubkey(A);
    renderProvider().unmount();
    expect(screen.queryByTestId("started")).toBeNull();

    _resetActiveAccountForTests();
    setActivePubkey(B);
    renderProvider();

    expect(screen.getByTestId("started")).toHaveTextContent("");
  });

  it("adopts the legacy blob for the account that claims it", () => {
    localStorage.setItem(
      APP_CONFIG_STORAGE_KEY,
      JSON.stringify({ theme: "light", startedDms: ["legacyPeer"] }),
    );
    setActivePubkey(A);

    renderProvider();

    expect(screen.getByTestId("started")).toHaveTextContent("legacyPeer");
  });
});
