import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingJoinNotice } from "./PendingJoinNotice";

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingJoinNotice", () => {
  it("says nothing while a quick signer answers, then explains a slow one", () => {
    vi.useFakeTimers();
    const { container } = render(<PendingJoinNotice state="signing" onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByText(/waiting for your signer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("offers Retry once an attempt failed", () => {
    const onRetry = vi.fn();
    render(<PendingJoinNotice state="failed" onRetry={onRetry} />);
    expect(screen.getByText(/can't see you here yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("stays hidden while a sealed Join is out, and with nothing pending", () => {
    const { container, rerender } = render(<PendingJoinNotice state="sending" onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PendingJoinNotice state={undefined} onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
