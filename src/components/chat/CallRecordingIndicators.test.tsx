import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { CallRecordingSignals, CallSignals } from "@/contexts/CallSignalsContext";

import { ParticipantRecordingFlags, RecordingIndicator } from "./CallRecordingIndicators";

const signals = vi.hoisted(() => ({ recording: null as CallRecordingSignals | null }));
vi.mock("@/contexts/CallSignalsContext", () => ({
  useCallSignals: () => ({ recording: signals.recording }) as unknown as CallSignals,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ pubkey }: { pubkey: string }) => <span>{pubkey}</span>,
}));

function recording(patch: Partial<CallRecordingSignals>): CallRecordingSignals {
  return {
    recorders: new Set(),
    refusing: new Set(),
    noRecord: false,
    setNoRecord: vi.fn(),
    announce: vi.fn(async () => true),
    names: { host: "Pod", channel: "studio" },
    ...patch,
  };
}

const renderWithTooltips = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

afterEach(() => {
  signals.recording = null;
});

describe("RecordingIndicator", () => {
  it("is absent outside a Concord call and when nobody records", () => {
    const { container, rerender } = renderWithTooltips(<RecordingIndicator />);
    expect(container).toBeEmptyDOMElement();
    signals.recording = recording({});
    rerender(<TooltipProvider><RecordingIndicator /></TooltipProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it("tells everyone in the call how many people are recording", () => {
    signals.recording = recording({ recorders: new Set(["ana", "ben"]) });
    renderWithTooltips(<RecordingIndicator />);
    expect(screen.getByRole("button", { name: "2 people are recording this call" })).toHaveTextContent("REC");
  });
});

describe("ParticipantRecordingFlags", () => {
  it("marks who records and who blocks recording", () => {
    signals.recording = recording({ recorders: new Set(["ana"]), refusing: new Set(["ben"]) });
    const { rerender } = render(<ParticipantRecordingFlags pubkey="ana" />);
    expect(screen.getByLabelText("Recording")).toBeInTheDocument();
    expect(screen.queryByLabelText("Blocks recording")).toBeNull();
    rerender(<ParticipantRecordingFlags pubkey="ben" />);
    expect(screen.getByLabelText("Blocks recording")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recording")).toBeNull();
  });
});
