import { useCallback, useEffect, useRef } from "react";

/**
 * Only one mounted composer may consume a document-level paste. This matters
 * when a channel and its open thread panel each render their own composer.
 */
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
 * Capture image clipboard files even when the composer textarea is not focused.
 * Editable controls keep their native paste behavior, and a paste already
 * handled by the textarea is ignored when it bubbles to `document`.
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
