import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useGlobalImagePaste } from "@/hooks/useGlobalImagePaste";

function clipboardPaste(target: Element, files: File[]): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function Harness({ name, onImages }: { name: string; onImages: (files: File[]) => void }) {
  const claimPasteOwnership = useGlobalImagePaste(onImages);
  return (
    <div data-testid={name} onPointerDownCapture={claimPasteOwnership}>
      <input aria-label={`${name}-input`} />
    </div>
  );
}

describe("useGlobalImagePaste", () => {
  it("attaches an image pasted outside the composer input", () => {
    const onImages = vi.fn();
    render(<Harness name="main" onImages={onImages} />);
    const image = new File(["image"], "pasted.png", { type: "image/png" });

    const event = clipboardPaste(document.body, [image]);

    expect(event.defaultPrevented).toBe(true);
    expect(onImages).toHaveBeenCalledWith([image]);
  });

  it("does not hijack image pastes in another editable control", () => {
    const onImages = vi.fn();
    render(<Harness name="main" onImages={onImages} />);
    const input = screen.getByLabelText("main-input");
    const image = new File(["image"], "pasted.png", { type: "image/png" });

    const event = clipboardPaste(input, [image]);

    expect(event.defaultPrevented).toBe(false);
    expect(onImages).not.toHaveBeenCalled();
  });

  it("routes a global paste only to the last-used composer", () => {
    const main = vi.fn();
    const thread = vi.fn();
    render(
      <>
        <Harness name="main" onImages={main} />
        <Harness name="thread" onImages={thread} />
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("thread"));
    const image = new File(["image"], "pasted.png", { type: "image/png" });

    clipboardPaste(document.body, [image]);

    expect(main).not.toHaveBeenCalled();
    expect(thread).toHaveBeenCalledWith([image]);
  });
});
