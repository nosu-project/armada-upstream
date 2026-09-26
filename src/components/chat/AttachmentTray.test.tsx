import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AttachmentTray, type TrayItem } from "./AttachmentTray";

const doc: TrayItem = {
  kind: "attachment",
  url: "https://blossom.example/report.pdf",
  mime: "application/pdf",
  label: "report.pdf",
  isImage: false,
  isVideo: false,
  isWebxdc: false,
  spoiler: false,
};

const photo: TrayItem = {
  kind: "attachment",
  url: "https://blossom.example/cat.jpg",
  mime: "image/jpeg",
  label: "cat.jpg",
  isImage: true,
  isVideo: false,
  isWebxdc: false,
  spoiler: false,
};

function renderTray(items: TrayItem[], isTouch = false) {
  const handlers = {
    onPreview: vi.fn(),
    onRemove: vi.fn(),
    onCancel: vi.fn(),
    onUpdate: vi.fn(),
  };
  render(
    <TooltipProvider>
      <AttachmentTray items={items} isTouch={isTouch} {...handlers} />
    </TooltipProvider>,
  );
  return handlers;
}

describe("AttachmentTray", () => {
  it("names a document inside its card, and marks uploads in progress", () => {
    renderTray([
      doc,
      { kind: "pending", id: "p1", label: "clip.mp4", phase: "uploading" },
      { kind: "pending", id: "p2", label: "big.mov", phase: "processing" },
    ]);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "clip.mp4: Uploading" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "big.mov: Preparing" })).toBeInTheDocument();
  });

  it("cancels an upload from its card", () => {
    const { onCancel } = renderTray([{ kind: "pending", id: "p1", label: "clip.mp4", phase: "uploading" }]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel clip.mp4" }));
    expect(onCancel).toHaveBeenCalledWith("p1");
  });

  it("puts a spoiler toggle on every media card, and only there", () => {
    const { onUpdate } = renderTray([photo, doc]);
    const toggle = screen.getByRole("button", { name: "Mark as spoiler: cat.jpg" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Mark as spoiler: report.pdf" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith("https://blossom.example/cat.jpg", { spoiler: true });
  });

  it("un-marks a spoiler from the same toggle", () => {
    const { onUpdate } = renderTray([{ ...photo, spoiler: true }]);
    const toggle = screen.getByRole("button", { name: "Remove spoiler: cat.jpg" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith("https://blossom.example/cat.jpg", { spoiler: false });
  });

  it("on touch, the spoiler toggle and remove sit on the card without opening the editor", () => {
    const { onUpdate, onRemove } = renderTray([photo], true);
    fireEvent.click(screen.getByRole("button", { name: "Mark as spoiler: cat.jpg" }));
    expect(onUpdate).toHaveBeenCalledWith("https://blossom.example/cat.jpg", { spoiler: true });
    fireEvent.click(screen.getByRole("button", { name: "Remove cat.jpg" }));
    expect(onRemove).toHaveBeenCalledWith("https://blossom.example/cat.jpg");
    expect(screen.queryByLabelText("Description (alt text)")).not.toBeInTheDocument();
  });

  it("shows a video's transcode progress on its pending card", () => {
    renderTray([{ kind: "pending", id: "p1", label: "clip.mp4", phase: "processing", progress: 0.42 }]);
    expect(screen.getByRole("status", { name: "clip.mp4: Preparing 42%" })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("saves a description from the edit dialog", () => {
    const { onUpdate } = renderTray([photo]);
    fireEvent.click(screen.getByRole("button", { name: "Edit attachment" }));
    fireEvent.change(screen.getByLabelText("Description (alt text)"), { target: { value: "A cat\non a keyboard" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Newlines are flattened: an imeta field is one line.
    expect(onUpdate).toHaveBeenCalledWith("https://blossom.example/cat.jpg", { alt: "A cat on a keyboard", spoiler: false });
  });

  it("on touch, a tap opens the editor rather than the lightbox", () => {
    const { onPreview } = renderTray([photo], true);
    fireEvent.click(screen.getByRole("button", { name: "Edit cat.jpg" }));
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description (alt text)")).toBeInTheDocument();
  });
});
