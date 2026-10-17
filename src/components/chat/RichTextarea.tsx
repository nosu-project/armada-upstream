import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";

import { FormatToolbar } from "@/components/chat/FormatToolbar";
import type { RichText } from "@/components/chat/useRichText";
import { HL, highlightRuns } from "@/lib/composerHighlight";
import type { MentionSpan } from "@/lib/composerText";
import { cn } from "@/lib/utils";

const LAYOUT_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "fontFeatureSettings",
  "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "textAlign", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "direction", "wordBreak", "overflowWrap",
] as const;

const italicCache = new Map<string, boolean>();
const ITALIC_SAMPLE = "The quick brown fox jumps over 13 lazy dogs, WAVY mmm iii";

/**
 * Whether italics keep every advance width in this font (true for a synthesized
 * oblique, rarely for a real italic face). Only then can the overlay slant text
 * without drifting from the caret.
 */
function italicKeepsWidth(style: CSSStyleDeclaration): boolean {
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const known = italicCache.get(font);
  if (known !== undefined) return known;
  let ok = false;
  if (!navigator.userAgent.includes("jsdom")) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = font;
      const upright = ctx.measureText(ITALIC_SAMPLE).width;
      ctx.font = `italic ${font}`;
      ok = Math.abs(ctx.measureText(ITALIC_SAMPLE).width - upright) < 0.5;
    }
  }
  italicCache.set(font, ok);
  return ok;
}

function runClass(flags: number): string | undefined {
  if (!flags) return undefined;
  return cn(
    flags & HL.MENTION ? "rounded-sm bg-primary/15 text-primary" : flags & HL.LINK && "text-primary",
    flags & HL.MARKER && (flags & HL.QUOTE ? "text-primary/70" : "text-muted-foreground/70"),
    flags & (HL.BOLD | HL.HEADING) && "rt-bold",
    flags & HL.ITALIC && "rt-italic",
    flags & HL.UNDERLINE && "rt-u",
    flags & HL.STRIKE && "rt-s",
    flags & HL.SPOILER && "rounded-sm bg-foreground/20",
    flags & HL.CODE && "rounded-sm bg-foreground/10",
    flags & HL.CODE_BLOCK && "bg-foreground/[0.06]",
    flags & HL.SUBTEXT && "text-muted-foreground",
    flags & HL.LIST && "text-primary/80",
  ) || undefined;
}

const HighlightedText = memo(function HighlightedText({ text, mentions }: { text: string; mentions: readonly MentionSpan[] }) {
  const runs = useMemo(() => highlightRuns(text, mentions), [text, mentions]);
  return (
    <>
      {runs.map((run, i) => (
        <span key={i} className={runClass(run.flags)}>{run.text}</span>
      ))}
      {/* A trailing newline only takes up a line when something follows it. */}
      {"\u200b"}
    </>
  );
});

interface RichTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "maxLength" | "defaultValue"> {
  rich: RichText;
  ref?: Ref<HTMLTextAreaElement>;
  /** The floating Bold/Italic/… bar over a selection. */
  formatToolbar?: boolean;
}

/**
 * The live textarea with its text drawn by an overlay laid out identically
 * underneath it: mentions as pills, markdown styled in place. Only
 * width-preserving styles are used, so the caret stays on the drawn glyphs.
 * Its parent must be the positioned box the overlay is placed in.
 */
export function RichTextarea({ rich, ref, className, onKeyDown, onCopy, onCut, formatToolbar = true, ...props }: RichTextareaProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const { textareaRef } = rich;

  const setRefs = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  }, [textareaRef, ref]);

  const syncScroll = useCallback(() => {
    const el = textareaRef.current;
    const inner = innerRef.current;
    if (el && inner) inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  }, [textareaRef]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const overlay = overlayRef.current;
    const inner = innerRef.current;
    if (!el || !overlay || !inner) return;
    const sync = () => {
      const style = getComputedStyle(el);
      overlay.style.top = `${el.offsetTop}px`;
      overlay.style.left = `${el.offsetLeft}px`;
      overlay.style.width = `${el.offsetWidth}px`;
      overlay.style.height = `${el.offsetHeight}px`;
      for (const prop of LAYOUT_PROPS) inner.style[prop] = style[prop];
      // The textarea's width less its scrollbar, which the text wraps inside.
      inner.style.width = `${el.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
      overlay.dataset.italic = italicKeepsWidth(style) ? "1" : "0";
      syncScroll();
    };
    sync();
    setReady(true);
    el.addEventListener("scroll", syncScroll);
    window.addEventListener("resize", sync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", syncScroll);
      window.removeEventListener("resize", sync);
      observer?.disconnect();
    };
  }, [textareaRef, syncScroll]);

  // A new value can scroll the field without a scroll event reaching us first.
  useLayoutEffect(syncScroll, [rich.display, syncScroll]);

  return (
    <>
      <div
        ref={overlayRef}
        aria-hidden
        className="rt-overlay pointer-events-none absolute overflow-hidden"
        style={{ visibility: ready ? undefined : "hidden" }}
      >
        <div
          ref={innerRef}
          dir={props.dir}
          className="box-border whitespace-pre-wrap break-words border-solid border-transparent"
        >
          <HighlightedText text={rich.display} mentions={rich.model.mentions} />
        </div>
      </div>
      <textarea
        {...props}
        ref={setRefs}
        value={rich.display}
        onChange={rich.onChange}
        onKeyDown={(e) => {
          if (rich.handleKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        onCopy={(e) => {
          if (rich.handle.copySelection(e.clipboardData)) e.preventDefault();
          onCopy?.(e);
        }}
        onCut={(e) => {
          if (rich.handle.copySelection(e.clipboardData)) {
            e.preventDefault();
            rich.handle.insertAtSelection("");
          }
          onCut?.(e);
        }}
        className={cn(className, ready && "rt-input")}
      />
      {formatToolbar && <FormatToolbar rich={rich} />}
    </>
  );
}
