/**
 * The comment tree under a forum post — CORD-03 §3.
 *
 * A threaded reply is a kind-1111 comment whose uppercase `E` names the
 * thread root and whose lowercase `e` names its immediate parent: the root
 * itself for a top-level comment, or another comment for a reply to one
 * (`buildConcordCommentTags`). The transport buckets every comment by root,
 * so the flat list it hands out already holds the whole discussion; this
 * module only arranges it by parent. Pure, so the arrangement is testable
 * without a transport.
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
 * Arrange a root's comments (oldest-first, as the transport orders them) as
 * a tree. Order is preserved within each level. A comment whose parent is
 * neither the root nor a comment in the list — the parent was deleted, hidden
 * or muted away, or is a cycle — is placed at the top level rather than
 * dropped: the reader loses the indentation, never the words.
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

  // Depths, and a reachability pass: a cycle among comments (A answers B, B
  // answers A) is attached nowhere by the loop above, and would vanish. The
  // walk also drops any child already placed — a back-edge into an
  // ancestor — so what comes out is a tree the renderer can recurse into.
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
    // Break the cycle here: this comment becomes top-level and the rest of
    // its ring hangs off it.
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
