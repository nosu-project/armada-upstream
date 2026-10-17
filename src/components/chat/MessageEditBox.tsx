import { useCallback, useEffect, useRef, useState } from "react";

import { RichTextarea } from "@/components/chat/RichTextarea";
import { useRichText } from "@/components/chat/useRichText";
import { useAutosizeTextarea } from "@/hooks/useAutosizeTextarea";

interface MessageEditBoxProps {
  /** The message's canonical content. */
  content: string;
  sendOnEnter: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/** In-place edit of a sent message: the composer's mention and markdown rendering, nothing else. */
export function MessageEditBox({ content, sendOnEnter, onSubmit, onCancel }: MessageEditBoxProps) {
  const [text, setText] = useState(content);
  useEffect(() => setText(content), [content]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichText({ value: text, onValueChange: setText, textareaRef });
  const autosizeRef = useAutosizeTextarea(rich.display);
  // Place the caret at the end when an edit opens (autoFocus puts it at the start).
  const caretPlacedRef = useRef(false);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      autosizeRef(el);
      if (!el) {
        caretPlacedRef.current = false;
        return;
      }
      if (caretPlacedRef.current) return;
      caretPlacedRef.current = true;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    },
    [autosizeRef],
  );

  return (
    <div className="relative mt-0.5">
      <RichTextarea
        rich={rich}
        ref={setRef}
        onKeyDown={(e) => {
          const saveKey = sendOnEnter
            ? e.key === "Enter" && !e.shiftKey
            : e.key === "Enter" && (e.ctrlKey || e.metaKey);
          if (saveKey) {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={1}
        className="block w-full resize-none rounded-md bg-background border border-input px-2 py-1.5 text-chat max-h-40 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2 touch:gap-4 mt-1 text-2xs text-muted-foreground">
        <button
          type="button"
          className="font-semibold text-primary hover:underline touch:py-2"
          onClick={() => onSubmit(text)}
        >
          Save
        </button>
        <button type="button" className="hover:text-foreground touch:py-2" onClick={onCancel}>
          Cancel
        </button>
        <span className="opacity-70">escape to cancel · enter to save</span>
      </div>
    </div>
  );
}
