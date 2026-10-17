import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { FormatToolbar } from "@/components/chat/FormatToolbar";
import type { RichText } from "@/components/chat/useRichText";
import { HL, highlightRuns, type HighlightRun } from "@/lib/composerHighlight";
import type { AtomSpan } from "@/lib/composerText";
import { cn } from "@/lib/utils";

const LAYOUT_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "fontFeatureSettings",
  "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "textAlign", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "direction", "wordBreak", "overflowWrap",
] as const;

/** A format's own markers stay plain: dimmed, never slanted, struck or underlined. */
const content = (flags: number, format: number) => (flags & format) !== 0 && (flags & HL.MARKER) === 0;
const slanted = (flags: number) => content(flags, HL.ITALIC);

function runClass(flags: number): string | undefined {
  if (!flags) return undefined;
  return cn(
    flags & HL.MENTION ? "rt-mention" : flags & HL.LINK && "text-primary",
    flags & HL.MARKER && (flags & HL.QUOTE ? "text-primary/70" : "text-muted-foreground/70"),
    content(flags, HL.BOLD | HL.HEADING) && "rt-bold",
    slanted(flags) && "rt-italic",
    content(flags, HL.UNDERLINE) && "rt-u",
    content(flags, HL.STRIKE) && "rt-s",
    content(flags, HL.SPOILER) && "rt-spoiler",
    content(flags, HL.CODE) && "rounded-sm bg-foreground/10",
    flags & HL.CODE_BLOCK && "bg-foreground/[0.06]",
    flags & HL.SUBTEXT && "text-muted-foreground",
    flags & HL.LIST && "text-primary/80",
  ) || undefined;
}

/**
 * Italics are skewed inline-blocks rather than an italic face, whose advance
 * widths differ. An inline-block is a break opportunity of its own, so every
 * whitespace-free chunk holding one is kept whole: the overlay then wraps only
 * where the textarea does, at whitespace.
 */
function renderRuns(runs: HighlightRun[], atoms: readonly AtomSpan[]): ReactNode[] {
  const emojiAt = new Map(atoms.filter((a) => a.emoji).map((a) => [a.dStart, a.emoji!]));
  const out: ReactNode[] = [];
  let pos = 0;
  let chunk: ReactNode[] = [];
  let chunkSlanted = false;
  let key = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    if (chunkSlanted) out.push(<span key={key++} className="rt-word">{chunk}</span>);
    else out.push(...chunk);
    chunk = [];
    chunkSlanted = false;
  };
  for (const run of runs) {
    const className = runClass(run.flags);
    if (run.flags & HL.EMOJI) {
      // One placeholder per emoji, holding its width; the image is drawn over it.
      for (let i = 0; i < run.text.length; i++) {
        const emoji = emojiAt.get(pos + i);
        chunk.push(
          <span key={key++} className="rt-emoji">
            <span className="opacity-0">{run.text[i]}</span>
            {emoji && <CustomEmojiImg name={emoji.shortcode} url={emoji.url} className="rt-emoji-img" />}
          </span>,
        );
      }
      pos += run.text.length;
      continue;
    }
    pos += run.text.length;
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue;
      const node = <span key={key++} className={className}>{part}</span>;
      if (/^\s/.test(part)) {
        flush();
        out.push(node);
      } else {
        chunk.push(node);
        chunkSlanted ||= slanted(run.flags);
      }
    }
  }
  flush();
  return out;
}

const HighlightedText = memo(function HighlightedText({ text, atoms }: { text: string; atoms: readonly AtomSpan[] }) {
  const nodes = useMemo(() => renderRuns(highlightRuns(text, atoms), atoms), [text, atoms]);
  return (
    <>
      {nodes}
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
 * underneath it: mentions as pills, custom emoji as images, markdown styled
 * in place. Only
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
          <HighlightedText text={rich.display} atoms={rich.model.atoms} />
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
