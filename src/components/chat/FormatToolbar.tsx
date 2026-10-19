import { Bold, Code, EyeOff, Italic, Quote, Strikethrough, Underline, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { RichText } from "@/components/chat/useRichText";
import { useIsTouch } from "@/hooks/useIsMobile";
import { getCaretCoordinates } from "@/lib/caretCoordinates";
import type { FormatKind } from "@/lib/markdownFormat";
import { cn } from "@/lib/utils";
import { defineMessages, useIntl, type MessageDescriptor } from "@/i18n";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

const LABELS = defineMessages({
  bold: { id: "formatToolbar.bold", defaultMessage: "Bold" },
  italic: { id: "formatToolbar.italic", defaultMessage: "Italic" },
  underline: { id: "formatToolbar.underline", defaultMessage: "Underline" },
  strike: { id: "formatToolbar.strikethrough", defaultMessage: "Strikethrough" },
  code: { id: "formatToolbar.code", defaultMessage: "Code" },
  spoiler: { id: "formatToolbar.spoiler", defaultMessage: "Spoiler" },
  quote: { id: "formatToolbar.quote", defaultMessage: "Quote" },
});

const BUTTONS: ReadonlyArray<{ kind: FormatKind; label: MessageDescriptor; keys: string; icon: LucideIcon }> = [
  { kind: "bold", label: LABELS.bold, keys: `${MOD}B`, icon: Bold },
  { kind: "italic", label: LABELS.italic, keys: `${MOD}I`, icon: Italic },
  { kind: "underline", label: LABELS.underline, keys: `${MOD}U`, icon: Underline },
  { kind: "strike", label: LABELS.strike, keys: `${MOD}Shift+X`, icon: Strikethrough },
  { kind: "code", label: LABELS.code, keys: `${MOD}E`, icon: Code },
  { kind: "spoiler", label: LABELS.spoiler, keys: `${MOD}Shift+H`, icon: EyeOff },
  { kind: "quote", label: LABELS.quote, keys: `${MOD}Shift+>`, icon: Quote },
];

interface ToolbarState {
  top: number;
  left: number;
  /** Above the selection (anchored by its bottom edge) or below it. */
  above: boolean;
  active: ReadonlySet<FormatKind>;
}

/** Room left above a touch selection for the platform's own cut/copy/paste bar. */
const TOUCH_CALLOUT_GAP = 52;

function sameState(a: ToolbarState | null, b: ToolbarState | null): boolean {
  if (!a || !b) return a === b;
  return a.top === b.top && a.left === b.left && a.above === b.above
    && a.active.size === b.active.size && [...a.active].every((k) => b.active.has(k));
}

/** Discord-style formatting bar over a non-empty textarea selection. */
export function FormatToolbar({ rich }: { rich: RichText }) {
  const intl = useIntl();
  const [state, setState] = useState<ToolbarState | null>(null);
  const isTouch = useIsTouch();
  const { textareaRef, handle } = rich;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let frame = 0;
    // Not mid-drag: the bar would chase the pointer.
    let dragging = false;

    const compute = (): ToolbarState | null => {
      if (dragging || document.activeElement !== el || el.selectionStart === el.selectionEnd) return null;
      const rect = el.getBoundingClientRect();
      const start = getCaretCoordinates(el, el.selectionStart);
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const startY = Math.min(Math.max(rect.top + start.top, rect.top), rect.bottom - lineHeight);
      const gap = isTouch ? TOUCH_CALLOUT_GAP : 6;
      const above = startY - gap - 48 > 8;
      let top: number;
      if (above) top = startY - gap;
      else {
        const end = getCaretCoordinates(el, el.selectionEnd);
        top = Math.min(rect.top + end.top, rect.bottom - lineHeight) + lineHeight + 6;
      }
      const width = BUTTONS.length * (isTouch ? 46 : 34) + 8;
      const left = Math.max(8, Math.min(rect.left + start.left - 8, window.innerWidth - width - 8));
      return { top: Math.round(top), left: Math.round(left), above, active: handle.selectionFormats() };
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = compute();
        setState((prev) => (sameState(prev, next) ? prev : next));
      });
    };
    const onPointerDown = () => {
      dragging = true;
      setState(null);
    };
    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      update();
    };

    el.addEventListener("select", update);
    el.addEventListener("keyup", update);
    el.addEventListener("input", update);
    el.addEventListener("focus", update);
    el.addEventListener("blur", update);
    el.addEventListener("scroll", update);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", update);
    document.addEventListener("selectionchange", update);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("select", update);
      el.removeEventListener("keyup", update);
      el.removeEventListener("input", update);
      el.removeEventListener("focus", update);
      el.removeEventListener("blur", update);
      el.removeEventListener("scroll", update);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", update);
      document.removeEventListener("selectionchange", update);
    };
  }, [textareaRef, handle, isTouch]);

  if (!state) return null;

  return createPortal(
    <div
      role="toolbar"
      aria-label={intl.formatMessage({ id: "formatToolbar.label", defaultMessage: "Text formatting" })}
      data-format-toolbar
      className="fixed z-[300] vessel-lift pointer-events-auto"
      style={{ top: state.top, left: state.left, transform: state.above ? "translateY(-100%)" : undefined }}
    >
      <div className="vessel flex items-center gap-0.5 p-1 animate-in fade-in-0 zoom-in-95 duration-100">
        {BUTTONS.map(({ kind, label: labelMessage, keys, icon: Icon }) => {
          const label = intl.formatMessage(labelMessage);
          const pressed = state.active.has(kind);
          return (
            <button
              key={kind}
              type="button"
              tabIndex={-1}
              aria-label={label}
              aria-pressed={pressed}
              title={`${label} (${keys})`}
              // Pointer-down, prevented: the textarea keeps focus and its selection.
              onPointerDown={(e) => {
                e.preventDefault();
                handle.format(kind);
              }}
              className={cn(
                "flex size-8 touch:size-11 items-center justify-center clip-corner transition-colors",
                pressed
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
