import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import { useMentionLabels } from "@/hooks/useMentionLabels";
import {
  applyDisplayEdit,
  buildDisplayModel,
  diffRange,
  mentionedPubkeys,
  spliceDisplay,
  toCanonical,
  toDisplay,
  type CanonicalEdit,
  type DisplayModel,
} from "@/lib/composerText";
import { activeFormats, toggleFormat, type FormatKind } from "@/lib/markdownFormat";

/** Imperative edits, in DISPLAY offsets (what `textarea.value` and its selection report). */
export interface RichTextHandle {
  /** Replace `[start, end)` with canonical `text` (which may carry `nostr:` references). */
  replaceRange(start: number, end: number, text: string): void;
  insertAtSelection(text: string): void;
  format(kind: FormatKind): void;
  /** Formats already applied to the current selection. */
  selectionFormats(): Set<FormatKind>;
  /** True where a mention starts, so `@Name` doesn't reopen the mention picker. */
  isMentionStart(pos: number): boolean;
  /**
   * Put the canonical text of a selection holding a mention on the clipboard,
   * so it pastes back as the mention rather than as `@Name`. False if there is none.
   */
  copySelection(clipboard: DataTransfer): boolean;
}

export interface UseRichTextOptions {
  /** Canonical text: mentions spelled `nostr:npub1…`. */
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Cap on the CANONICAL length, which is what is sent. */
  maxLength?: number;
  /** A replacement to apply right after a user edit (emoji shortcode completion). */
  completeEdit?: (
    display: string,
    caret: number,
    prevDisplay: string,
  ) => { start: number; end: number; replacement: string } | null;
}

export interface RichText {
  model: DisplayModel;
  display: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Formatting shortcuts; true when the key was consumed. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  handle: RichTextHandle;
}

const SHORTCUTS: Record<string, FormatKind> = { b: "bold", i: "italic", u: "underline", e: "code" };
const SHIFT_SHORTCUTS: Record<string, FormatKind> = { x: "strike", h: "spoiler", ">": "quote", ".": "quote" };

/**
 * A textarea whose value shows mentions as `@Name` while the caller keeps the
 * canonical NIP-27 text. Edits are mapped back through `composerText.ts`.
 */
export function useRichText({ value, onValueChange, textareaRef, maxLength = Infinity, completeEdit }: UseRichTextOptions): RichText {
  const pubkeys = useMemo(() => mentionedPubkeys(value), [value]);
  const labelFor = useMentionLabels(pubkeys);
  const model = useMemo(() => buildDisplayModel(value, labelFor), [value, labelFor]);

  const labelForRef = useRef(labelFor);
  labelForRef.current = labelFor;
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const completeEditRef = useRef(completeEdit);
  completeEditRef.current = completeEdit;
  const maxLengthRef = useRef(maxLength);
  maxLengthRef.current = maxLength;

  /** The newest model, ahead of the render that will catch up with it. */
  const modelRef = useRef(model);
  /** A selection to restore once React has written the new display value. */
  const pendingSel = useRef<{ start: number; end: number; focus: boolean } | null>(null);
  /** The value a native `insertText` is about to produce, and what it means. */
  const pendingHint = useRef<{ display: string; canonical: string } | null>(null);

  const renderedRef = useRef(model);
  if (renderedRef.current !== model) {
    const prev = renderedRef.current;
    renderedRef.current = model;
    modelRef.current = model;
    // A name resolving changes the display under a still caret: keep it on the same text.
    const el = textareaRef.current;
    if (el && prev.canonical === model.canonical && prev.display !== model.display && !pendingSel.current
      && document.activeElement === el && el.value === prev.display) {
      pendingSel.current = {
        start: toDisplay(model, toCanonical(prev, el.selectionStart, "start"), "start"),
        end: toDisplay(model, toCanonical(prev, el.selectionEnd)),
        focus: false,
      };
    }
  }

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const sel = pendingSel.current;
    if (!el || !sel) return;
    pendingSel.current = null;
    if (sel.focus) el.focus();
    el.setSelectionRange(sel.start, sel.end);
  }, [model.display, textareaRef]);

  const commit = useCallback((canonical: string, start: number, end: number) => {
    const el = textareaRef.current;
    const prev = modelRef.current;
    const next = buildDisplayModel(canonical, labelForRef.current);
    const sel = { start: toDisplay(next, start, "start"), end: toDisplay(next, end), focus: true };

    if (el && canonical === prev.canonical && el.value === next.display) {
      el.focus();
      el.setSelectionRange(sel.start, sel.end);
      return;
    }
    // Through the editing command when there is one, so Ctrl+Z can undo it.
    if (el && typeof document.execCommand === "function") {
      if (document.activeElement !== el) el.focus();
      const d = diffRange(el.value, next.display);
      pendingHint.current = { display: next.display, canonical };
      el.setSelectionRange(d.start, d.end);
      let ok = false;
      try {
        ok = document.execCommand(d.inserted ? "insertText" : "delete", false, d.inserted);
      } catch {
        // Unsupported: fall through to a plain state update.
      }
      pendingHint.current = null;
      if (ok && el.value === next.display) {
        el.setSelectionRange(sel.start, sel.end);
        return;
      }
    }
    modelRef.current = next;
    pendingSel.current = sel;
    onValueChangeRef.current(canonical);
  }, [textareaRef]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const typed = el.value;
    const hint = pendingHint.current;
    if (hint && typed === hint.display) {
      modelRef.current = buildDisplayModel(hint.canonical, labelForRef.current);
      onValueChangeRef.current(hint.canonical);
      return;
    }

    const prev = modelRef.current;
    let edit: CanonicalEdit = applyDisplayEdit(prev, typed, el.selectionEnd);
    const max = maxLengthRef.current;
    if (edit.canonical.length > max && edit.canonical.length > prev.canonical.length) {
      const over = edit.canonical.length - Math.max(max, prev.canonical.length);
      edit = {
        canonical: edit.canonical.slice(0, edit.caret - over) + edit.canonical.slice(edit.caret),
        caret: edit.caret - over,
      };
    }
    let next = buildDisplayModel(edit.canonical, labelForRef.current);
    const completion = completeEditRef.current?.(next.display, toDisplay(next, edit.caret), prev.display);
    if (completion) {
      edit = spliceDisplay(next, completion.start, completion.end, completion.replacement);
      next = buildDisplayModel(edit.canonical, labelForRef.current);
    }
    modelRef.current = next;
    if (next.display !== typed) {
      const caret = toDisplay(next, edit.caret);
      pendingSel.current = { start: caret, end: caret, focus: false };
    }
    onValueChangeRef.current(edit.canonical);
  }, []);

  const handle = useMemo<RichTextHandle>(() => {
    const selection = (): [number, number] => {
      const el = textareaRef.current;
      const len = modelRef.current.display.length;
      return [el?.selectionStart ?? len, el?.selectionEnd ?? len];
    };
    return {
      replaceRange(start, end, text) {
        const edit = spliceDisplay(modelRef.current, start, end, text);
        commit(edit.canonical, edit.caret, edit.caret);
      },
      insertAtSelection(text) {
        const [start, end] = selection();
        const edit = spliceDisplay(modelRef.current, start, end, text);
        commit(edit.canonical, edit.caret, edit.caret);
      },
      format(kind) {
        const m = modelRef.current;
        const [start, end] = selection();
        const r = toggleFormat(m.canonical, toCanonical(m, start, "start"), toCanonical(m, end), kind);
        commit(r.text, r.start, r.end);
      },
      selectionFormats() {
        const m = modelRef.current;
        const [start, end] = selection();
        return activeFormats(m.canonical, toCanonical(m, start, "start"), toCanonical(m, end));
      },
      isMentionStart(pos) {
        return modelRef.current.mentions.some((m) => m.dStart === pos);
      },
      copySelection(clipboard) {
        const m = modelRef.current;
        const [start, end] = selection();
        if (start === end || !m.mentions.some((s) => s.dStart < end && s.dEnd > start)) return false;
        clipboard.setData("text/plain", m.canonical.slice(toCanonical(m, start, "start"), toCanonical(m, end)));
        return true;
      },
    };
  }, [commit, textareaRef]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.nativeEvent.isComposing) return false;
    const key = e.key.toLowerCase();
    const kind = e.shiftKey ? SHIFT_SHORTCUTS[key] : SHORTCUTS[key];
    if (!kind) return false;
    e.preventDefault();
    handle.format(kind);
    return true;
  }, [handle]);

  return { model, display: model.display, textareaRef, onChange, handleKeyDown, handle };
}
