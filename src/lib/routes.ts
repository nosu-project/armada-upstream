/**
 * The one place a chat route is spelled.
 *
 * Every chat surface — NIP-29 relay groups (and Buzz, which shares their
 * routes), Concord, DMs — names a location with the same four
 * things: the surface, the room, an optionally open thread, and an optionally
 * focused message. Before this module those paths were ~60 ad-hoc template
 * literals, the community id was recovered from notification paths by
 * `path.split("/")[2]`, and the analytics sanitizer kept a hand-ordered mirror
 * of the router that had to be remembered separately. A builder plus a parser
 * makes all three the same fact.
 *
 * The shapes, and what distinguishes them:
 *
 *     /c/<community>/<channel>                    the channel
 *     /c/<community>/<channel>/m/<id>             a message in its timeline
 *     /c/<community>/<channel>/t/<root>           the thread opened at <root>
 *     /c/<community>/<channel>/t/<root>/m/<id>    a reply INSIDE that thread
 *
 * The `m`/`t` markers are what make "in a thread or not" legible rather than
 * positional: a thread root has a timeline identity (`/m/<root>`) and a thread
 * identity (`/t/<root>`), and they are different places to be.
 *
 * A message id is a durable part of the location, not a transient scroll hint
 * — arriving at one and refreshing returns to it. That is also why these ids
 * must never reach analytics raw: see `chatRouteTemplate`, which
 * `sanitizePlausibleUrl` is built on.
 */

import { DM_PEER_SEP } from "@/lib/nip17/protocol";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { shareOrigin } from "@/lib/shareOrigin";

/** Non-channel panes of a Concord community. */
export const CONCORD2_PANES = [
  "all",
  "mentions",
  "threads",
  "projects",
  "audit",
  "invites",
  "banned",
  "members",
  "reports",
  "roles",
  "settings",
  "suspicious",
] as const;
export type Concord2Pane = (typeof CONCORD2_PANES)[number];

/**
 * Non-channel panes of a NIP-29 server.
 *
 * These occupy the same path position as a group id. A NIP-29 group id is an
 * arbitrary relay-chosen string, so a group literally named `projects` is
 * unreachable — a pre-existing property of the router (static segments outrank
 * `:groupId`), reproduced here so the parser agrees with what actually renders.
 * Concord ids are hex and cannot collide with a pane word at all.
 */
export const NIP29_PANES = ["projects", "inbox"] as const;
export type Nip29Pane = (typeof NIP29_PANES)[number];

export interface Nip29Route {
  kind: "nip29";
  relayUrl: string;
  /** Absent ⇒ the server's channel list. Mutually exclusive with `pane`. */
  groupId?: string;
  pane?: Nip29Pane;
  threadRoot?: string;
  messageId?: string;
}

export interface Concord2Route {
  kind: "concord";
  communityId: string;
  /** Mutually exclusive with `pane`. */
  channelId?: string;
  pane?: Concord2Pane;
  threadRoot?: string;
  messageId?: string;
}

export interface DmRoute {
  kind: "dm";
  /**
   * The CONVERSATION KEY, not necessarily one pubkey — see `dmConvKey`. A 1:1
   * (and Note to Self) is a bare pubkey, so this is unchanged from when DMs
   * were only ever pairwise and every existing `/dm/<npub>` link still
   * resolves; a group is its participants joined by {@link DM_PEER_SEP}.
   *
   * Absent ⇒ the conversation list.
   */
  peer?: string;
  messageId?: string;
}

export type ChatRoute = Nip29Route | Concord2Route | DmRoute;

function isConcordPane(value: string): value is Concord2Pane {
  return (CONCORD2_PANES as readonly string[]).includes(value);
}

function isNip29Pane(value: string): value is Nip29Pane {
  return (NIP29_PANES as readonly string[]).includes(value);
}

/**
 * Append the thread/message suffix shared by every room-bearing surface.
 *
 * A message id is only meaningful under a room, so a `messageId` with no room
 * is dropped rather than producing a path that names nothing.
 */
function withFocus(
  base: string,
  focus: { threadRoot?: string; messageId?: string },
): string {
  let path = base;
  if (focus.threadRoot) path += `/t/${encodeURIComponent(focus.threadRoot)}`;
  if (focus.messageId) path += `/m/${encodeURIComponent(focus.messageId)}`;
  return path;
}

/** Build the path for a chat location. */
export function chatRoute(route: ChatRoute): string {
  switch (route.kind) {
    case "nip29": {
      const base = `/s/${relayToRouteParam(route.relayUrl)}`;
      if (route.pane) return `${base}/${route.pane}`;
      if (!route.groupId) return base;
      return withFocus(`${base}/${encodeURIComponent(route.groupId)}`, route);
    }
    case "concord": {
      const base = `/c/${encodeURIComponent(route.communityId)}`;
      if (route.pane) return `${base}/${route.pane}`;
      if (!route.channelId) return base;
      return withFocus(`${base}/${encodeURIComponent(route.channelId)}`, route);
    }
    case "dm": {
      if (!route.peer) return "/dm";
      // Each participant is escaped on its own so the separator survives as a
      // literal — it is a legal sub-delim in a path segment, and `/dm/<a>,<b>`
      // reads as what it is instead of `%2C`.
      const segment = route.peer
        .split(DM_PEER_SEP)
        .map(encodeURIComponent)
        .join(DM_PEER_SEP);
      return withFocus(`/dm/${segment}`, { messageId: route.messageId });
    }
  }
}

/**
 * The same location with the thread and message focus stripped — i.e. the room
 * the reader is in, independent of what they were pointed at inside it.
 *
 * Closing a thread, giving up on an unresolvable permalink, and sending a
 * message all navigate here: each means "I am no longer looking at that", and
 * leaving the segment behind would make the URL claim otherwise (and re-snap
 * the reader on the next remount).
 */
export function roomRoute(route: ChatRoute): ChatRoute {
  switch (route.kind) {
    case "nip29":
      return { kind: "nip29", relayUrl: route.relayUrl, groupId: route.groupId, pane: route.pane };
    case "concord":
      return {
        kind: "concord",
        communityId: route.communityId,
        channelId: route.channelId,
        pane: route.pane,
      };
    case "dm":
      return { kind: "dm", peer: route.peer };
  }
}

/** The room path with thread/message focus stripped. Shorthand for the pair. */
export function roomPath(route: ChatRoute): string {
  return chatRoute(roomRoute(route));
}

/**
 * The same location with only the message focus dropped.
 *
 * Giving up on an unresolvable `/m/<id>` should close the permalink, not the
 * thread panel the reader is looking at — so the `/t/<root>` segment stays.
 */
export function withoutMessage(route: ChatRoute): ChatRoute {
  if (route.kind === "dm") return { kind: "dm", peer: route.peer };
  const { messageId: _dropped, ...rest } = route;
  return rest;
}

/**
 * Parse the `/t/<root>` + `/m/<id>` suffix that follows a room segment.
 *
 * Returns `null` for anything that isn't one of the four legal shapes, so an
 * unrecognized path is reported as unparseable rather than silently losing its
 * tail — which for the analytics sanitizer is the difference between a
 * template and a leaked event id.
 */
function parseFocus(
  rest: readonly string[],
): { threadRoot?: string; messageId?: string } | null {
  if (rest.length === 0) return {};
  if (rest.length === 2) {
    const [marker, value] = rest;
    if (marker === "t") return { threadRoot: decodeURIComponent(value) };
    if (marker === "m") return { messageId: decodeURIComponent(value) };
    return null;
  }
  if (rest.length === 4 && rest[0] === "t" && rest[2] === "m") {
    return {
      threadRoot: decodeURIComponent(rest[1]),
      messageId: decodeURIComponent(rest[3]),
    };
  }
  return null;
}

/**
 * Parse a chat path back into its parts, or `null` when it names no chat
 * location (a static page, an unknown shape, an unusable relay param).
 */
export function parseChatRoute(pathname: string): ChatRoute | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 0) return null;

  switch (seg[0]) {
    case "s": {
      if (seg.length < 2) return null;
      const relayUrl = routeParamToRelay(seg[1]);
      if (!relayUrl) return null;
      if (seg.length === 2) return { kind: "nip29", relayUrl };
      const room = decodeURIComponent(seg[2]);
      if (seg.length === 3 && isNip29Pane(room)) return { kind: "nip29", relayUrl, pane: room };
      const focus = parseFocus(seg.slice(3));
      if (!focus) return null;
      return { kind: "nip29", relayUrl, groupId: room, ...focus };
    }
    case "c": {
      if (seg.length < 2) return null;
      const communityId = decodeURIComponent(seg[1]);
      if (seg.length === 2) return { kind: "concord", communityId };
      const room = decodeURIComponent(seg[2]);
      if (seg.length === 3 && isConcordPane(room)) {
        return { kind: "concord", communityId, pane: room };
      }
      const focus = parseFocus(seg.slice(3));
      if (!focus) return null;
      return { kind: "concord", communityId, channelId: room, ...focus };
    }
    // The pre-rename DM path. Parsed (not just redirected) because a stale
    // push subscription or a tray notification can still land on it, and the
    // pageview may fire before AppRouter's redirect replaces it.
    case "dm":
    case "dms": {
      if (seg.length === 1) return { kind: "dm" };
      const peer = seg[1]
        .split(DM_PEER_SEP)
        .map(decodeURIComponent)
        .join(DM_PEER_SEP);
      if (seg.length === 2) return { kind: "dm", peer };
      const focus = parseFocus(seg.slice(2));
      // DMs have no thread panel, so `/t/` there names nothing.
      if (!focus || focus.threadRoot) return null;
      return { kind: "dm", peer, messageId: focus.messageId };
    }
    default:
      return null;
  }
}

/**
 * The route *template* for a parsed location — identifiers replaced by their
 * param names.
 *
 * This is what analytics reports. It is derived from the same parse the app
 * navigates by, rather than from a hand-ordered list of patterns kept beside
 * it, because the two drifting apart does not break a screen: it silently
 * ships a community id, a DM counterparty's pubkey or an event id to a third
 * party.
 */
export function chatRouteTemplate(route: ChatRoute): string {
  switch (route.kind) {
    case "nip29": {
      if (route.pane) return `/s/:server/${route.pane}`;
      if (!route.groupId) return "/s/:server";
      return focusTemplate("/s/:server/:groupId", route);
    }
    case "concord": {
      if (route.pane) return `/c/:communityId/${route.pane}`;
      if (!route.channelId) return "/c/:communityId";
      return focusTemplate("/c/:communityId/:channelId", route);
    }
    case "dm": {
      if (!route.peer) return "/dm";
      return route.messageId ? "/dm/:peer/m/:messageId" : "/dm/:peer";
    }
  }
}

function focusTemplate(
  base: string,
  focus: { threadRoot?: string; messageId?: string },
): string {
  let template = base;
  if (focus.threadRoot) template += "/t/:threadRoot";
  if (focus.messageId) template += "/m/:messageId";
  return template;
}

/**
 * An absolute, shareable URL for a chat location — what "Copy message link"
 * writes to the clipboard.
 *
 * `shareOrigin()` is the public web origin even on native, where the WebView's
 * own origin (`capacitor://localhost`, `https://localhost`) would be useless
 * to whoever receives the link.
 */
export function chatUrl(route: ChatRoute): string {
  return `${shareOrigin()}${chatRoute(route)}`;
}
