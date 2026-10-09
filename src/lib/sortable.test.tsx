import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DndContext, horizontalListSortingStrategy, PointerSensor, SortableContext, useSensor, useSensors, useSortable } from "./sortable";

function Item({ id, onClick }: { id: string; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id });
  return (
    <button ref={setNodeRef} {...attributes} {...listeners} data-dragging={isDragging} onClick={onClick}>
      {id}
    </button>
  );
}

function List({ onClick }: { onClick: () => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  return (
    <DndContext sensors={sensors}>
      <SortableContext items={["a", "b"]} strategy={horizontalListSortingStrategy}>
        <Item id="a" onClick={onClick} />
        <Item id="b" onClick={onClick} />
      </SortableContext>
    </DndContext>
  );
}

/** Tap the way a touch browser sequences it: pointerdown, then the compat touchstart. */
function tap(el: HTMLElement): boolean {
  fireEvent.pointerDown(el, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
  const notCancelled = fireEvent.touchStart(el, { cancelable: true, touches: [{ clientX: 10, clientY: 10 }] });
  fireEvent.pointerUp(el, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
  return notCancelled;
}

describe("useSortable", () => {
  beforeAll(() => {
    // jsdom has no PointerEvent; without one `button` never reaches the handler.
    if (typeof window.PointerEvent === "undefined") {
      window.PointerEvent = class extends MouseEvent {
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "";
        }
      } as unknown as typeof PointerEvent;
    }
  });

  it("still clicks a handle that is tapped, though its touchstart was cancelled", () => {
    const onClick = vi.fn();
    render(<List onClick={onClick} />);

    const cancelled = !tap(screen.getByText("a"));

    expect(cancelled).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("clicks once when the browser delivers the native click anyway", () => {
    const onClick = vi.fn();
    render(<List onClick={onClick} />);
    const a = screen.getByText("a");

    tap(a);
    fireEvent.click(a);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not click after a drag", () => {
    const onClick = vi.fn();
    render(<List onClick={onClick} />);
    const a = screen.getByText("a");

    fireEvent.pointerDown(a, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.touchStart(a, { cancelable: true, touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.pointerMove(window, { pointerType: "touch", clientX: 40, clientY: 10 });
    fireEvent.pointerUp(a, { button: 0, pointerType: "touch", clientX: 40, clientY: 10 });

    expect(onClick).not.toHaveBeenCalled();
  });

  it("starts a mouse drag after a couple of pixels, under the touch threshold", () => {
    render(<List onClick={() => {}} />);
    const a = screen.getByText("a");

    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerType: "mouse", clientX: 13, clientY: 10 });

    expect(a.dataset.dragging).toBe("true");
    fireEvent.pointerUp(a, { button: 0, pointerType: "mouse", clientX: 13, clientY: 10 });
  });

  it("keeps the full threshold for touch", () => {
    render(<List onClick={() => {}} />);
    const a = screen.getByText("a");

    fireEvent.pointerDown(a, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerType: "touch", clientX: 13, clientY: 10 });

    expect(a.dataset.dragging).toBe("false");
    fireEvent.pointerUp(a, { button: 0, pointerType: "touch", clientX: 13, clientY: 10 });
  });

  it("blocks the browser's native drag of an image inside the handle", () => {
    render(<List onClick={() => {}} />);
    const a = screen.getByText("a");

    fireEvent.pointerDown(a, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    const allowed = fireEvent.dragStart(a);
    fireEvent.pointerUp(a, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });

    expect(allowed).toBe(false);
    // Only during the gesture.
    expect(fireEvent.dragStart(a)).toBe(true);
  });
});
