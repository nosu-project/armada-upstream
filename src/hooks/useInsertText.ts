import { useCallback } from 'react';

interface InsertAtCursorParams {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Insert text in a textarea: `insertAtCursor` between explicit offsets (autocomplete),
 * `insertEmoji` at the current selection. Reads the live `textareaRef.current.value` so the
 * callbacks stay STABLE across keystrokes (avoids churning children's listeners).
 */
export function useInsertText(
  textareaRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  _content: string,
  setContent: (value: string) => void,
) {
  const insertAtCursor = useCallback(
    ({ start, end, replacement }: InsertAtCursorParams) => {
      const current = textareaRef.current?.value ?? '';
      const newContent = current.slice(0, start) + replacement + current.slice(end);
      setContent(newContent);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          const pos = start + replacement.length;
          textarea.setSelectionRange(pos, pos);
        }
      });
    },
    [setContent, textareaRef],
  );

  /** Inserts at the current selection (or appends if no ref). */
  const insertEmoji = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current;
      if (textarea) {
        const current = textarea.value;
        const start = textarea.selectionStart ?? current.length;
        const end = textarea.selectionEnd ?? current.length;
        const newContent = current.slice(0, start) + emoji + current.slice(end);
        setContent(newContent);
        requestAnimationFrame(() => {
          textarea.focus();
          const pos = start + emoji.length;
          textarea.setSelectionRange(pos, pos);
        });
      } else {
        setContent(emoji);
      }
    },
    [setContent, textareaRef],
  );

  return { insertAtCursor, insertEmoji };
}
