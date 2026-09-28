import { useCallback, useEffect, useRef } from "react";

/** Only one composer may consume a document-level paste (channel + thread panel). */
let pasteOwner: symbol | undefined;
const mountedComposers: symbol[] = [];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

function imageFiles(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && file.type.startsWith("image/"));
}

/**
 * Capture pasted images even when the textarea isn't focused. Editable controls keep native
 * paste; pastes the textarea already handled are ignored.
 */
export function useGlobalImagePaste(onImages: (files: File[]) => void): () => void {
  const id = useRef(Symbol("chat-composer"));
  const onImagesRef = useRef(onImages);
  onImagesRef.current = onImages;

  useEffect(() => {
    const token = id.current;
    mountedComposers.push(token);
    pasteOwner ??= token;

    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || pasteOwner !== token) return;
      if (isEditable(event.target) || isEditable(document.activeElement)) return;

      const files = imageFiles(event);
      if (files.length === 0) return;

      event.preventDefault();
      onImagesRef.current(files);
    };

    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
      const index = mountedComposers.indexOf(token);
      if (index >= 0) mountedComposers.splice(index, 1);
      if (pasteOwner === token) pasteOwner = mountedComposers.at(-1);
    };
  }, []);

  return useCallback(() => {
    pasteOwner = id.current;
  }, []);
}
