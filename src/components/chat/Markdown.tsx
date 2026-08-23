import { useEffect, useReducer } from "react";

import { getCachedHighlight, highlightAsync } from "@/lib/codeHighlight";

import type { Root, RootContent } from "hast";
import type { ReactNode } from "react";

/**
 * Render lowlight's hast output as React nodes: nested `<span>`s carrying the
 * `hljs-*` scope classes that `index.css` colors. highlight.js emits only
 * elements and text, so nothing else needs handling — and building elements
 * (rather than setting innerHTML) keeps the block inside React's escaping.
 */
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
 * The highlighted tree for a code block. Answered synchronously from the cache
 * when this block (or an identical one) was highlighted before; otherwise the
 * grammars load in the background and the block re-renders highlighted. No
 * language, an unknown one, or an oversized block all stay plain (`null`).
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
        // The grammar chunk failed to load (offline, stale deploy) — the block
        // simply stays plain.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, lang, cached]);
  return cached ?? null;
}

/** Fenced code block, syntax-highlighted when its fence names a known language. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const tree = useHighlight(code, lang);
  return (
    <pre
      data-lang={lang}
      className="my-1.5 max-w-full overflow-x-auto rounded-md border border-border/60 bg-muted/50 px-3 py-2 font-mono text-[13px] leading-snug whitespace-pre-wrap break-words"
    >
      <code className={tree ? "hljs" : undefined}>{tree ? renderHast(tree.children) : code}</code>
    </pre>
  );
}

/** `inline code` span. */
export function InlineCode({ code }: { code: string }) {
  return (
    <code className="rounded-[3px] border border-border/40 bg-muted/60 px-1 py-px font-mono text-[0.85em]">
      {code}
    </code>
  );
}
