import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useMentionLabels", () => ({
  useMentionLabels: () => () => "@Alice",
}));

import { RichTextarea } from "@/components/chat/RichTextarea";
import { useRichText } from "@/components/chat/useRichText";

const ref = `nostr:${nip19.npubEncode("a".repeat(64))}`;

function Field({ initial, onValue }: { initial: string; onValue: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichText({
    value,
    onValueChange: (v) => {
      setValue(v);
      onValue(v);
    },
    textareaRef,
  });
  return (
    <div className="relative">
      <RichTextarea rich={rich} aria-label="field" />
    </div>
  );
}

afterEach(cleanup);

describe("RichTextarea", () => {
  it("shows a mention by name and keeps the canonical text", () => {
    const onValue = vi.fn();
    render(<Field initial={`hi ${ref} `} onValue={onValue} />);
    const field = screen.getByLabelText("field") as HTMLTextAreaElement;
    expect(field.value).toBe("hi @Alice ");

    fireEvent.change(field, { target: { value: "hi @Alice there", selectionStart: 15, selectionEnd: 15 } });
    expect(onValue).toHaveBeenLastCalledWith(`hi ${ref} there`);
    expect(field.value).toBe("hi @Alice there");
  });

  it("formats the selection on Ctrl+B", () => {
    const onValue = vi.fn();
    render(<Field initial="say hi" onValue={onValue} />);
    const field = screen.getByLabelText("field") as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(4, 6);
    fireEvent.keyDown(field, { key: "b", ctrlKey: true });
    expect(onValue).toHaveBeenLastCalledWith("say **hi**");
    expect(field.value).toBe("say **hi**");
  });

  it("draws the text in the overlay", () => {
    const { container } = render(<Field initial="a **b**" onValue={() => {}} />);
    const overlay = container.querySelector(".rt-overlay")!;
    expect(overlay.textContent).toBe("a **b**\u200b");
    expect([...overlay.querySelectorAll(".rt-bold")].map((n) => n.textContent)).toEqual(["b"]);
  });
});

describe("RichTextarea italics", () => {
  it("skews italic text inside a word kept whole, markers upright", () => {
    const { container } = render(<Field initial="a *it* b" onValue={() => {}} />);
    const word = container.querySelector(".rt-overlay .rt-word")!;
    expect(word.textContent).toBe("*it*");
    expect([...word.querySelectorAll(".rt-italic")].map((n) => n.textContent)).toEqual(["it"]);
  });
});
