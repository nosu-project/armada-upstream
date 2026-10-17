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
   * Put the canonical text of a selection holding a mention or emoji on the
   * clipboard, so it pastes back as one rather than as its display text. False if there is none.
   */
  copySelection(clipboard: DataTransfer): boolean;
}

export interface UseRichTextOptions {
  /** Canonical text: mentions spelled `nostr:npub1…`, custom emoji `:shortcode:`. */
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Cap on the CANONICAL length, which is what is sent. */
  maxLength?: number;
  /** The image of a custom emoji shortcode, drawn in place of `:shortcode:`. */
  emojiUrl?: (shortcode: string) => string | undefined;
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
export function useRichText({ value, onValueChange, textareaRef, maxLength = Infinity, emojiUrl, completeEdit }: UseRichTextOptions): RichText {
  const pubkeys = useMemo(() => mentionedPubkeys(value), [value]);
  const labelFor = useMentionLabels(pubkeys);
  const model = useMemo(() => buildDisplayModel(value, labelFor, emojiUrl), [value, labelFor, emojiUrl]);

  // Read when used: a render inside execCommand may have resolved a label meanwhile.
  const labelForRef = useRef(labelFor);
  labelForRef.current = labelFor;
  const emojiUrlRef = useRef(emojiUrl);
  emojiUrlRef.current = emojiUrl;
  const build = useCallback((canonical: string) => buildDisplayModel(canonical, labelForRef.current, emojiUrlRef.current), []);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const completeEditRef = useRef(completeEdit);
  completeEditRef.current = completeEdit;
  const maxLengthRef = useRef(maxLength);
  maxLengthRef.current = maxLength;

  /** The newest model, ahead of the render that will catch up with it. */
  const modelRef = useRef(model);
  /** A CANONICAL selection to restore once React has written the new display value. */
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
        start: toCanonical(prev, el.selectionStart, "start"),
        end: toCanonical(prev, el.selectionEnd),
        focus: false,
      };
    }
  }

  const applySelection = useCallback((el: HTMLTextAreaElement, m: DisplayModel, sel: { start: number; end: number; focus: boolean }) => {
    if (sel.focus) el.focus();
    el.setSelectionRange(toDisplay(m, sel.start, "start"), toDisplay(m, sel.end));
  }, []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const sel = pendingSel.current;
    if (!el || !sel) return;
    pendingSel.current = null;
    applySelection(el, model, sel);
  }, [model, textareaRef, applySelection]);

  /** Make `canonical` the value, with a CANONICAL selection. */
  const commit = useCallback((canonical: string, start: number, end: number) => {
    const el = textareaRef.current;
    const sel = { start, end, focus: true };
    const current = () => build(canonical);

    if (el && canonical === modelRef.current.canonical && el.value === modelRef.current.display) {
      applySelection(el, modelRef.current, sel);
      return;
    }
    // Through the editing command when there is one, so Ctrl+Z can undo it.
    if (el && typeof document.execCommand === "function") {
      if (document.activeElement !== el) el.focus();
      const target = current().display;
      const d = diffRange(el.value, target);
      pendingHint.current = { display: target, canonical };
      el.setSelectionRange(d.start, d.end);
      let ok = false;
      try {
        ok = document.execCommand(d.inserted ? "insertText" : "delete", false, d.inserted);
      } catch {
        // Unsupported: fall through to a plain state update.
      }
      pendingHint.current = null;
      const now = renderedRef.current.canonical === canonical ? renderedRef.current : current();
      if (ok && el.value === now.display) {
        modelRef.current = now;
        applySelection(el, now, sel);
        return;
      }
    }
    if (renderedRef.current.canonical === canonical) {
      // Already rendered (synchronously, inside the command): no effect will run for it.
      modelRef.current = renderedRef.current;
      if (el) applySelection(el, renderedRef.current, sel);
      return;
    }
    modelRef.current = current();
    pendingSel.current = sel;
    onValueChangeRef.current(canonical);
  }, [textareaRef, applySelection, build]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const typed = el.value;
    const hint = pendingHint.current;
    if (hint && typed === hint.display) {
      modelRef.current = build(hint.canonical);
      onValueChangeRef.current(hint.canonical);
      return;
    }

    const prev = modelRef.current;
    const inputType = (e.nativeEvent as InputEvent).inputType;
    const external = inputType === "insertFromPaste" || inputType === "insertFromDrop";
    let edit: CanonicalEdit = applyDisplayEdit(prev, typed, el.selectionEnd, { keepLabels: !external });
    const max = maxLengthRef.current;
    if (edit.canonical.length > max && edit.canonical.length > prev.canonical.length) {
      const over = edit.canonical.length - Math.max(max, prev.canonical.length);
      edit = {
        canonical: edit.canonical.slice(0, edit.caret - over) + edit.canonical.slice(edit.caret),
        caret: edit.caret - over,
      };
    }
    let next = build(edit.canonical);
    const completion = completeEditRef.current?.(next.display, toDisplay(next, edit.caret), prev.display);
    if (completion) {
      edit = spliceDisplay(next, completion.start, completion.end, completion.replacement);
      next = build(edit.canonical);
    }
    modelRef.current = next;
    if (next.display !== typed) pendingSel.current = { start: edit.caret, end: edit.caret, focus: false };
    onValueChangeRef.current(edit.canonical);
  }, [build]);

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
        return modelRef.current.atoms.some((m) => m.pubkey && m.dStart === pos);
      },
      copySelection(clipboard) {
        const m = modelRef.current;
        const [start, end] = selection();
        if (start === end || !m.atoms.some((s) => s.dStart < end && s.dEnd > start)) return false;
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
