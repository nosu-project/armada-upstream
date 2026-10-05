import { Check, Copy } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { getCachedHighlight, highlightAsync } from "@/lib/codeHighlight";
import { writeClipboardText } from "@/lib/clipboard";

import type { Root, RootContent } from "hast";
import type { ReactNode } from "react";

/** Lowlight hast → React `<span>`s with `hljs-*` classes (no innerHTML, so React escapes). */
function renderHast(nodes: RootContent[], keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (node.type === "text") {
      out.push(node.value);
    } else if (node.type === "element") {
      const cls = node.properties.className;
      const key = `${keyPrefix}${i}`;
      out.push(
        <span key={key} className={Array.isArray(cls) ? cls.join(" ") : undefined}>
          {renderHast(node.children, `${key}-`)}
        </span>,
      );
    }
  });
  return out;
}

/**
 * Highlighted tree, synchronously from cache when possible; otherwise grammars
 * load in the background. No/unknown language or oversized blocks stay plain.
 */
function useHighlight(code: string, lang: string | undefined): Root | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const cached = lang ? getCachedHighlight(lang, code) : null;
  useEffect(() => {
    if (!lang || cached !== undefined) return;
    let cancelled = false;
    highlightAsync(lang, code).then(
      () => {
        if (!cancelled) rerender();
      },
      () => {
        // Grammar chunk failed (offline, stale deploy): stay plain.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, lang, cached]);
  return cached ?? null;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const tree = useHighlight(code, lang);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  return (
    <div className="group/code relative my-1.5 max-w-full">
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        onClick={(e) => {
          e.stopPropagation();
          writeClipboardText(code).then(
            () => {
              setCopied(true);
              clearTimeout(resetTimer.current);
              resetTimer.current = setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
        className="absolute right-1 top-1 z-10 inline-flex size-7 touch:size-9 items-center justify-center clip-corner bg-background/70 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 touch:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre
        data-lang={lang}
        className="max-w-full min-h-9 touch:min-h-11 overflow-x-auto clip-corner-lg bg-muted/50 py-2 pl-3 pr-10 touch:pr-11 font-mono text-[13px] leading-snug whitespace-pre-wrap break-words"
      >
        <code className={tree ? "hljs" : undefined}>{tree ? renderHast(tree.children) : code}</code>
      </pre>
    </div>
  );
}

export function InlineCode({ code }: { code: string }) {
  return (
    <code className="rounded-[3px] border border-border/40 bg-muted/60 px-1 py-px font-mono text-[0.85em]">
      {code}
    </code>
  );
}
