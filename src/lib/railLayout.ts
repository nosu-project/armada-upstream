/**
 * Data model + pure operations for the community-rail layout: a Discord-style
 * ordered list of items (NIP-29 servers / Concord communities, by stable rail
 * key) and folders that group them.
 *
 * The layout is persisted in AppConfig (`railLayout`) and synced across
 * devices in its own encrypted NIP-78 document (`${APP_ID}/rail`). All
 * functions here are pure so they can be unit-tested and so the ServerRail
 * component stays a thin view over them.
 *
 * Keys are the rail's stable item keys: a normalized relay URL for NIP-29
 * servers, `c2:${communityId}` for Concord communities,
 * `dm:${pubkey}` for a direct-message conversation the user put on the rail.
 *
 * DM keys are the one kind whose presence here IS the fact: a server or a
 * community is on the rail because it's in the user's kind 10009 / Community
 * List and the arrangement only orders it, but a DM is on the rail because the
 * user said so and nowhere else records that. So the arrangement is the whole
 * source of truth for them, and a `dm:` key is live by definition.
 *
 * The stored layout may reference keys that aren't currently "live" (a
 * Concord list still loading, a server on a relay that hasn't answered yet).
 * Those keys are kept in place — never dropped by these ops — so a drag
 * performed before everything has loaded can't destroy another device's
 * folders. Rendering simply skips them.
 *
 * The one exception is {@link removeKey}, which is called when the user
 * REMOVES a community: leaving must purge the key here as well as from the
 * source list, or a later re-add would silently resurrect it at its old
 * position inside its old folder.
 */

import { nip19 } from "nostr-tools";

import { relayToRouteParam } from "@/lib/platform";

/** A single ungrouped community/server in the rail. */
export interface RailItemNode {
  type: "item";
  key: string;
}

/** A named folder grouping several items (Discord server-folder analog). */
export interface RailFolderNode {
  type: "folder";
  id: string;
  name: string;
  keys: string[];
}

export type RailLayoutNode = RailItemNode | RailFolderNode;

/** What is being dragged: a single item, or a whole folder. */
export type RailDragSource = { kind: "item"; key: string } | { kind: "folder"; id: string };

/** Where a drag lands. */
export type RailDropTarget =
  /** Insert at the top level, before the node with this anchor. */
  | { type: "before"; anchor: string }
  /** Append at the end of the top level. */
  | { type: "end" }
  /** Merge the dragged item with a top-level item into a NEW folder. */
  | { type: "combine"; withKey: string }
  /** Insert the dragged item into an existing folder (before a child, or appended). */
  | { type: "into-folder"; folderId: string; beforeKey?: string };

/** Stable rail key for a direct-message conversation with `pubkey` (hex). */
export function dmRailKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

/**
 * The peer pubkey a `dm:` rail key names, or `null` for any other key. The hex
 * shape is checked here rather than trusted: the key round-trips through
 * synced settings, and every caller either encodes it as an npub or hands it
 * to a profile query.
 */
export function railKeyDmPubkey(key: string): string | null {
  if (!key.startsWith("dm:")) return null;
  const pubkey = key.slice("dm:".length);
  return /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null;
}

/**
 * Every DM peer on the rail, in visual order. Read straight from the stored
 * arrangement, because for DMs there is no separate list to be live against.
 */
export function railDmPubkeys(stored: RailLayoutNode[]): string[] {
  const out: string[] = [];
  for (const key of flattenLayout(stored)) {
    const pubkey = railKeyDmPubkey(key);
    if (pubkey && !out.includes(pubkey)) out.push(pubkey);
  }
  return out;
}

/** Stable DOM/target anchor for a top-level node. */
export function itemAnchor(key: string): string {
  return `item:${key}`;
}
export function folderAnchor(id: string): string {
  return `folder:${id}`;
}
export function nodeAnchor(node: RailLayoutNode): string {
  return node.type === "item" ? itemAnchor(node.key) : folderAnchor(node.id);
}

/** All item keys in visual order (folders flattened in place). */
export function flattenLayout(nodes: RailLayoutNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === "item") out.push(node.key);
    else out.push(...node.keys);
  }
  return out;
}

/**
 * Map a stable rail item key to its React Router path, or `null` if the key
 * isn't a recognized community/server key. NIP-29 servers use their normalized
 * relay URL as the key; Concord uses `c2:`-prefixed community ids.
 */
export function railKeyToRoute(key: string): string | null {
  if (key.startsWith("c2:")) {
    return `/c/${encodeURIComponent(key.slice("c2:".length))}`;
  }
  if (key.startsWith("dm:")) {
    const pubkey = railKeyDmPubkey(key);
    // The peer route, not `/dm` — on mobile the conversation list and the
    // thread are the same route's two states, so landing on the list would
    // make the rail icon a shortcut to somewhere the user then has to search.
    return pubkey ? `/dm/${nip19.npubEncode(pubkey)}` : null;
  }
  // NIP-29 server (key = normalized relay URL).
  return `/s/${relayToRouteParam(key)}`;
}

/**
 * Canonicalize a layout: de-duplicate keys (first occurrence wins), drop
 * empty folders, and dissolve single-item folders in place (Discord
 * behavior: dragging the second-to-last item out of a folder dissolves it).
 */
export function normalizeLayout(nodes: RailLayoutNode[]): RailLayoutNode[] {
  const seenKeys = new Set<string>();
  const seenFolders = new Set<string>();
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "item") {
      if (seenKeys.has(node.key)) continue;
      seenKeys.add(node.key);
      out.push(node);
    } else {
      if (seenFolders.has(node.id)) continue;
      seenFolders.add(node.id);
      const keys = node.keys.filter((k) => {
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      if (keys.length === 0) continue;
      if (keys.length === 1) {
        out.push({ type: "item", key: keys[0] });
        continue;
      }
      out.push({ ...node, keys });
    }
  }
  return out;
}

/**
 * Build the working layout from the stored one plus the currently-live item
 * keys: appends any live key the layout doesn't know about (newly joined
 * server / community) as a top-level item at the end. Never removes unknown
 * keys.
 */
export function mergeLayout(stored: RailLayoutNode[], liveKeys: string[]): RailLayoutNode[] {
  const out = normalizeLayout(stored);
  const known = new Set(flattenLayout(out));
  for (const key of liveKeys) {
    if (!known.has(key)) {
      known.add(key);
      out.push({ type: "item", key });
    }
  }
  return out;
}

/** Remove an item key from everywhere in the layout (without normalizing). */
function detachKey(nodes: RailLayoutNode[], key: string): RailLayoutNode[] {
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "item") {
      if (node.key !== key) out.push(node);
    } else {
      out.push(node.keys.includes(key) ? { ...node, keys: node.keys.filter((k) => k !== key) } : node);
    }
  }
  return out;
}

/**
 * Drop an item key from the layout entirely — the counterpart to a removal
 * from the source list (leaving a community, removing a server).
 *
 * Unlike the render-time filter, this is destructive on purpose. The layout
 * otherwise keeps keys it doesn't recognize forever, so without this a user
 * who left a community and later rejoined it would find it back in whatever
 * folder it used to live in, at its old position.
 */
export function removeKey(nodes: RailLayoutNode[], key: string): RailLayoutNode[] {
  return normalizeLayout(detachKey(nodes, key));
}

/**
 * Random id for a newly-created folder. `crypto.randomUUID` is a
 * secure-context-only API — it is UNDEFINED when the client is served over
 * plain http on a non-localhost host (a `./start.sh` box reached by LAN IP),
 * which made every folder-creating drop throw mid-gesture. `getRandomValues`
 * works in insecure contexts, so fall back to it.
 */
function generateFolderId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Apply a completed drag to the layout, returning the new normalized layout.
 * `newFolderId` supplies the id for a folder created by a combine drop
 * (injectable for tests; defaults to a random UUID).
 */
export function applyDrop(
  nodes: RailLayoutNode[],
  source: RailDragSource,
  target: RailDropTarget,
  newFolderId?: string,
): RailLayoutNode[] {
  // No-op guards: dropping a node onto its own anchor.
  const sourceAnchor = source.kind === "item" ? itemAnchor(source.key) : folderAnchor(source.id);
  if (target.type === "before" && target.anchor === sourceAnchor) return normalizeLayout(nodes);

  if (source.kind === "folder") {
    // Folders only move at the top level: no combining, no nesting.
    if (target.type !== "before" && target.type !== "end") return normalizeLayout(nodes);
    const folder = nodes.find(
      (n): n is RailFolderNode => n.type === "folder" && n.id === source.id,
    );
    if (!folder) return normalizeLayout(nodes);
    const without = nodes.filter((n) => !(n.type === "folder" && n.id === source.id));
    return normalizeLayout(insertTopLevel(without, folder, target));
  }

  const key = source.key;
  const detached = detachKey(nodes, key);

  switch (target.type) {
    case "before":
    case "end":
      return normalizeLayout(insertTopLevel(detached, { type: "item", key }, target));
    case "combine": {
      if (target.withKey === key) return normalizeLayout(nodes);
      const idx = detached.findIndex((n) => n.type === "item" && n.key === target.withKey);
      if (idx === -1) {
        // Combine target vanished (raced): fall back to appending.
        return normalizeLayout([...detached, { type: "item", key }]);
      }
      const folder: RailFolderNode = {
        type: "folder",
        id: newFolderId ?? generateFolderId(),
        name: "",
        keys: [target.withKey, key],
      };
      const out = [...detached];
      out.splice(idx, 1, folder);
      return normalizeLayout(out);
    }
    case "into-folder": {
      const out = detached.map((n) => {
        if (n.type !== "folder" || n.id !== target.folderId) return n;
        const keys = [...n.keys];
        const at = target.beforeKey ? keys.indexOf(target.beforeKey) : -1;
        if (at === -1) keys.push(key);
        else keys.splice(at, 0, key);
        return { ...n, keys };
      });
      // Folder vanished (raced): fall back to appending at the top level.
      if (!out.some((n) => n.type === "folder" && n.id === target.folderId && n.keys.includes(key))) {
        return normalizeLayout([...out, { type: "item", key }]);
      }
      return normalizeLayout(out);
    }
  }
}

function insertTopLevel(
  nodes: RailLayoutNode[],
  node: RailLayoutNode,
  target: { type: "before"; anchor: string } | { type: "end" },
): RailLayoutNode[] {
  if (target.type === "end") return [...nodes, node];
  const idx = nodes.findIndex((n) => nodeAnchor(n) === target.anchor);
  if (idx === -1) return [...nodes, node];
  const out = [...nodes];
  out.splice(idx, 0, node);
  return out;
}

/** Rename a folder. */
export function renameFolder(nodes: RailLayoutNode[], id: string, name: string): RailLayoutNode[] {
  return nodes.map((n) => (n.type === "folder" && n.id === id ? { ...n, name } : n));
}

/** Dissolve a folder in place: its items pop back out as top-level items. */
export function dissolveFolder(nodes: RailLayoutNode[], id: string): RailLayoutNode[] {
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "folder" && node.id === id) {
      out.push(...node.keys.map((key): RailItemNode => ({ type: "item", key })));
    } else {
      out.push(node);
    }
  }
  return normalizeLayout(out);
}

// ─── Drag geometry ───────────────────────────────────────────────────────

/**
 * A rendered rail slot, frozen at drag pickup. Top-level items, folder
 * buttons/headers, and the children of expanded folders each contribute one.
 */
export interface RailSlot {
  /** `item:<key>` or `folder:<id>`. */
  anchor: string;
  /** Set when this slot is a child inside an expanded folder. */
  parentFolderId?: string;
  /** Viewport Y of the slot's top edge. */
  top: number;
  height: number;
}

/** The computed landing spot for the pointer's current position. */
export interface RailDropPlan {
  target: RailDropTarget;
  /** Viewport Y for the insertion-indicator line (gap drops). */
  indicatorY?: number;
  /** Anchor of the node to highlight (combine / drop-into-folder). */
  highlightAnchor?: string;
}

/**
 * Fraction of an ITEM slot's height (centered) that counts as its "combine"
 * band; the rest of the slot + the gaps between slots are reorder zones.
 * Folders accept a drop across their FULL rect (hovering a folder means
 * "put it in there" — reordering around it uses the gaps), which keeps the
 * into-folder drop forgiving, especially under a finger.
 */
const ITEM_COMBINE_BAND = 0.7;

/**
 * Given the pointer's viewport Y, the frozen slots, and what is being
 * dragged, decide where the drop would land — Discord semantics:
 *
 * - Anywhere over a folder drops into that folder; the middle band of an
 *   item combines the two into a new folder.
 * - Everywhere else is a gap: insert before the nearest slot below the
 *   pointer (inside a folder when that slot is a folder child), or at the end.
 * - Folders themselves only reorder at the top level.
 */
export function planDrop(y: number, slots: RailSlot[], source: RailDragSource): RailDropPlan | null {
  // Exclude the dragged node's own slot(s); folders only see top-level slots.
  const eligible = slots.filter((s) => {
    if (source.kind === "item") {
      return s.anchor !== itemAnchor(source.key);
    }
    return s.parentFolderId === undefined && s.anchor !== folderAnchor(source.id);
  });
  if (eligible.length === 0) return null;

  // 1. Combine / into-folder bands (items only).
  if (source.kind === "item") {
    const band = eligible.find((s) => {
      const frac = s.anchor.startsWith("folder:") ? 1 : ITEM_COMBINE_BAND;
      const inset = (s.height * (1 - frac)) / 2;
      return y >= s.top + inset && y <= s.top + s.height - inset;
    });
    if (band) {
      const center = band.top + band.height / 2;
      if (band.parentFolderId !== undefined) {
        // Middle of a folder child: insert before/after it within the folder.
        if (y < center) {
          return {
            target: { type: "into-folder", folderId: band.parentFolderId, beforeKey: keyOf(band.anchor) },
            indicatorY: band.top - 2,
          };
        }
        const next = nextFolderSibling(eligible, band);
        return {
          target: {
            type: "into-folder",
            folderId: band.parentFolderId,
            beforeKey: next ? keyOf(next.anchor) : undefined,
          },
          indicatorY: band.top + band.height + 2,
        };
      }
      if (band.anchor.startsWith("folder:")) {
        return {
          target: { type: "into-folder", folderId: band.anchor.slice("folder:".length) },
          highlightAnchor: band.anchor,
        };
      }
      return {
        target: { type: "combine", withKey: keyOf(band.anchor) },
        highlightAnchor: band.anchor,
      };
    }
  }

  // 2. Gap: before the first slot whose center is below the pointer.
  for (const s of eligible) {
    if (y < s.top + s.height / 2) {
      if (s.parentFolderId !== undefined) {
        return {
          target: { type: "into-folder", folderId: s.parentFolderId, beforeKey: keyOf(s.anchor) },
          indicatorY: s.top - 2,
        };
      }
      return { target: { type: "before", anchor: s.anchor }, indicatorY: s.top - 2 };
    }
  }

  const last = eligible[eligible.length - 1];
  return { target: { type: "end" }, indicatorY: last.top + last.height + 2 };
}

function keyOf(anchor: string): string {
  return anchor.startsWith("item:") ? anchor.slice("item:".length) : anchor;
}

/** The next slot in the same folder after `slot`, if any. */
function nextFolderSibling(slots: RailSlot[], slot: RailSlot): RailSlot | undefined {
  const idx = slots.indexOf(slot);
  for (let i = idx + 1; i < slots.length; i++) {
    if (slots[i].parentFolderId === slot.parentFolderId) return slots[i];
    return undefined; // Left the folder's contiguous run.
  }
  return undefined;
}
