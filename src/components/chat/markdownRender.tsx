import { Fragment } from "react";

import { Spoiler } from "@/components/chat/Spoiler";
import { parseInline } from "@/lib/markdown";

import type { InlineNode } from "@/lib/markdown";
import type { ReactNode } from "react";

/**
 * Render an inline-markdown AST; leaf text goes through `renderLeaf` (emoji,
 * highlighting) and atoms from `parseInlineRun` through `renderAtom`.
 */
export function renderInlineNodes<A = never>(
  nodes: InlineNode<A>[],
  renderLeaf: (text: string) => ReactNode,
  keyPrefix = "",
  renderAtom?: (atom: A, key: string) => ReactNode,
): ReactNode[] {
  return nodes.map((node: InlineNode<A>, i) => {
    const key = `${keyPrefix}md-${i}`;
    if (node.type === "text") {
      return <Fragment key={key}>{renderLeaf(node.value)}</Fragment>;
    }
    if (node.type === "atom") {
      return renderAtom ? renderAtom(node.atom, key) : null;
    }
    const children = renderInlineNodes(node.children, renderLeaf, `${key}-`, renderAtom);
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

export function renderInlineMarkdown(
  text: string,
  renderLeaf: (text: string) => ReactNode,
  keyPrefix = "",
): ReactNode[] {
  return renderInlineNodes(parseInline(text), renderLeaf, keyPrefix);
}
