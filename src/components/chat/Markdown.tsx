import { Fragment, useState } from "react";

import { parseInline } from "@/lib/markdown";
import { cn } from "@/lib/utils";

import type { InlineNode } from "@/lib/markdown";
import type { ReactNode } from "react";

/**
 * Render an inline-markdown AST. Leaf text goes through `renderLeaf`, so the
 * caller keeps its existing plain-text pipeline (custom emoji, search-term
 * highlighting) inside bold/italic/etc. spans.
 */
export function renderInlineNodes(
  nodes: InlineNode[],
  renderLeaf: (text: string) => ReactNode,
  keyPrefix = "",
): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}md-${i}`;
    if (node.type === "text") {
      return <Fragment key={key}>{renderLeaf(node.value)}</Fragment>;
    }
    const children = renderInlineNodes(node.children, renderLeaf, `${key}-`);
    switch (node.type) {
      case "strong":
        return <strong key={key} className="font-semibold">{children}</strong>;
      case "em":
        return <em key={key}>{children}</em>;
      case "u":
        return <u key={key} className="underline underline-offset-2">{children}</u>;
      case "s":
        return <s key={key}>{children}</s>;
      case "spoiler":
        return <Spoiler key={key}>{children}</Spoiler>;
    }
  });
}

/** Parse + render a text run's inline markdown in one step. */
export function renderInlineMarkdown(
  text: string,
  renderLeaf: (text: string) => ReactNode,
  keyPrefix = "",
): ReactNode[] {
  return renderInlineNodes(parseInline(text), renderLeaf, keyPrefix);
}

/** Discord-style `||spoiler||`: blacked out until clicked. */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role={revealed ? undefined : "button"}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : "Reveal spoiler"}
      onClick={(e) => {
        if (revealed) return;
        e.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(e) => {
        if (revealed) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRevealed(true);
        }
      }}
      className={cn(
        "rounded-[3px] px-0.5 transition-colors",
        revealed
          ? "bg-muted/60"
          : "bg-foreground/90 text-transparent cursor-pointer select-none [&_img]:invisible [&_a]:text-transparent",
      )}
    >
      {children}
    </span>
  );
}

/** Fenced code block. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <pre
      data-lang={lang}
      className="my-1.5 max-w-full overflow-x-auto rounded-md border border-border/60 bg-muted/50 px-3 py-2 font-mono text-[13px] leading-snug whitespace-pre-wrap break-words"
    >
      <code>{code}</code>
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
