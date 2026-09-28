/**
 * The comment tree under a forum post (CORD-03 §3). A kind-1111 comment's
 * uppercase `E` names the thread root and lowercase `e` its immediate parent
 * (`buildConcordCommentTags`). This only arranges the transport's flat list by parent.
 */

import type { ChatMsg } from "@/components/chat/transport";

/** The rumor id a comment answers: its first lowercase `e` tag. */
export function commentParentOf(msg: { tags: string[][] }): string | undefined {
  return msg.tags.find((t) => t[0] === "e")?.[1];
}

export interface CommentNode {
  comment: ChatMsg;
  /** 0 for a comment on the post itself. */
  depth: number;
  children: CommentNode[];
}

/**
 * Arrange a root's comments (oldest-first) as a tree, preserving order per level.
 * A comment with an unknown parent (deleted, muted, or a cycle) goes top-level
 * rather than being dropped.
 */
export function buildCommentTree(rootId: string, comments: readonly ChatMsg[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const comment of comments) nodes.set(comment.id, { comment, depth: 0, children: [] });

  const top: CommentNode[] = [];
  for (const comment of comments) {
    const parentId = commentParentOf(comment);
    const parent = parentId && parentId !== rootId ? nodes.get(parentId) : undefined;
    const node = nodes.get(comment.id)!;
    if (parent && parent !== node) parent.children.push(node);
    else top.push(node);
  }

  // Reachability pass: comments in a cycle are attached nowhere above and would
  // vanish; back-edges are dropped so the output is a tree.
  const seen = new Set<string>();
  const walk = (node: CommentNode, depth: number) => {
    seen.add(node.comment.id);
    node.depth = depth;
    const kept: CommentNode[] = [];
    for (const child of node.children) {
      if (seen.has(child.comment.id)) continue;
      kept.push(child);
      walk(child, depth + 1);
    }
    node.children = kept;
  };
  for (const node of top) walk(node, 0);
  for (const comment of comments) {
    if (seen.has(comment.id)) continue;
    // Break the cycle: this comment becomes top-level.
    const node = nodes.get(comment.id)!;
    top.push(node);
    walk(node, 0);
  }
  return top;
}

/** Every comment of a subtree, the node first, depth-first. */
export function flattenCommentTree(nodes: readonly CommentNode[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  const walk = (list: readonly CommentNode[]) => {
    for (const node of list) {
      out.push(node.comment);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
