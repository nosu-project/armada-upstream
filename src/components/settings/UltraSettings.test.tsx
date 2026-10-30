import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";

import { SOAPBOX_BITCOIN, SOAPBOX_MONERO, UltraSettings } from "./UltraSettings";

vi.mock("@/components/Confetti", () => ({ Confetti: () => <div data-testid="confetti" /> }));

function Harness({ initial = defaultConfig }: { initial?: AppConfig }) {
  const [config, setConfig] = useState(initial);
  return (
    <AppContext.Provider value={{ config, updateConfig: (fn) => setConfig(fn) }}>
      <UltraSettings />
    </AppContext.Provider>
  );
}

describe("UltraSettings", () => {
  afterEach(() => vi.useRealTimers());

  it("activates for $0.00 with confetti, then offers the donation addresses", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Get Ultra for \$0\.00/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $0.00" }));
    expect(screen.getByText(/Processing your payment/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Welcome to Ultra!")).toBeInTheDocument();
    expect(screen.getByTestId("confetti")).toBeInTheDocument();
    expect(screen.getByTitle(SOAPBOX_BITCOIN)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Monero" }));
    expect(screen.getByTitle(SOAPBOX_MONERO)).toBeInTheDocument();
  });

  it("cancels back to the pitch", () => {
    render(<Harness initial={{ ...defaultConfig, armadaUltraSince: Date.now() }} />);
    expect(screen.getByText("You're Ultra")).toBeInTheDocument();
    expect(screen.queryByTestId("confetti")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Ultra" }));
    expect(screen.getByRole("button", { name: /Get Ultra/ })).toBeInTheDocument();
  });
});
