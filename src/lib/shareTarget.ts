import { Capacitor, registerPlugin } from "@capacitor/core";

import { parseChatRoute } from "@/lib/routes";

/**
 * Android share-target bridge (ShareTargetPlugin.java) + the in-memory share
 * stash the rest of the app works against.
 *
 * A share reaches Armada three ways:
 *  - Android Direct Share: the user picked a conversation IN the system share
 *    sheet — the intent carries EXTRA_SHORTCUT_ID, which is the conversation's
 *    in-app route (that spelling is the contract between the two shortcut
 *    writers, ShareTargetPlugin.publishShortcuts and the notification
 *    service's pushConversationShortcut).
 *  - Android plain share ("Armada" in the sheet): no shortcut id — the user
 *    still owes us a destination, so the share flow lands on /share (the
 *    destination picker).
 *  - Web Share Target (installed PWA): a GET /share?title&text&url; SharePage
 *    reads the params itself and stashes on pick.
 *
 * In all three the handoff to the conversation is the same: the payload is
 * stashed here against a destination route, the app navigates there, and the
 * ChatComposer mounted at that path consumes it (text into the draft, files
 * into the normal attachment pipeline). Native shares split "where to go"
 * (peekShare — instant) from "the bytes" (checkShare — copies streams into the
 * app cache), so navigation never waits on a large video copy; the composer
 * subscribes to the stash and picks the payload up whenever it lands.
 */

interface SharedFileMeta {
  name: string;
  type: string;
  size: number;
  /** Absolute path in the app cache; fetchable via Capacitor.convertFileSrc. */
  path: string;
}

interface PeekShareResult {
  pending: boolean;
  shortcutId?: string;
}

interface CheckShareResult extends PeekShareResult {
  text?: string;
  subject?: string;
  files?: SharedFileMeta[];
}

/** One ranked Direct Share suggestion; `id` is the conversation's route. */
export interface ShareShortcutItem {
  id: string;
  label: string;
  iconUrl?: string;
}

/** One row of {@link dumpShareShortcuts}. */
export interface ShareShortcutDump {
  id: string;
  label: string;
  rank: number;
  shareTarget: boolean;
}

interface ShareTargetNativePlugin {
  peekShare(): Promise<PeekShareResult>;
  checkShare(): Promise<CheckShareResult>;
  publishShortcuts(opts: { shortcuts: ShareShortcutItem[] }): Promise<{ published: number }>;
  getMaxShortcuts(): Promise<{ max: number }>;
  dumpShortcuts(): Promise<{ shortcuts: ShareShortcutDump[]; max: number }>;
  clearShortcuts(): Promise<void>;
  addListener(
    eventName: "shareReceived",
    cb: () => void,
  ): Promise<{ remove: () => void }>;
}

export const ShareTarget = registerPlugin<ShareTargetNativePlugin>("ShareTarget");

/** True where ShareTargetPlugin.java exists (Android only, like the service). */
export function hasShareTarget(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * How many Direct Share suggestions to publish on this device.
 *
 * A device property, not a constant: the per-activity shortcut cap is commonly
 * 15 but 5 on plenty of builds, and publishing past it silently evicts. The
 * fallback matches what the publisher assumed before the plugin could answer.
 */
export async function maxShareShortcuts(): Promise<number> {
  try {
    const { max } = await ShareTarget.getMaxShortcuts();
    return Number.isFinite(max) && max > 0 ? max : 8;
  } catch {
    return 8;
  }
}

/**
 * Drop every published Direct Share suggestion.
 *
 * Called on logout: they name the previous account's conversations, carry
 * their avatars, and deep-link into rooms the next account may not be in.
 */
export async function clearShareShortcuts(): Promise<void> {
  if (!hasShareTarget()) return;
  try {
    await ShareTarget.clearShortcuts();
  } catch {
    // Best-effort, like every other teardown step in the purge.
  }
}

/**
 * The live dynamic shortcut set, for diagnosing what the OS actually holds.
 *
 * Whether the share sheet DISPLAYS a published suggestion, and in what order,
 * is the system's decision and is not observable from here — so this answers
 * the one question that is: did what we published survive.
 */
export async function dumpShareShortcuts(): Promise<{
  shortcuts: ShareShortcutDump[];
  max: number;
}> {
  if (!hasShareTarget()) return { shortcuts: [], max: 0 };
  try {
    return await ShareTarget.dumpShortcuts();
  } catch {
    return { shortcuts: [], max: 0 };
  }
}

// ── The share stash ──────────────────────────────────────────────────────────

export interface SharePayload {
  text: string;
  files: File[];
  /**
   * Content tags to send alongside the text — NIP-92 `imeta` and NIP-30
   * `emoji`, set by a message forward (see `forwardableTags`). They describe
   * content the text REFERENCES but cannot carry: an attachment's MIME/dims
   * and, for a client-encrypted blob, the only copy of its decryption key.
   *
   * Never persisted (drafts drop them), because an encrypted attachment's key
   * is an ephemeral secret — same reasoning as the composer's per-upload
   * encryption ref. Absent for OS shares, which carry files, not references.
   */
  tags?: string[][];
}

/**
 * The one in-flight share. `route === null` means the user hasn't picked a
 * destination yet (SharePage shows it); a set route means the ChatComposer at
 * that path owns it.
 */
let stash: { payload: SharePayload; route: string | null } | null = null;
const stashListeners = new Set<() => void>();

function emitStashChanged(): void {
  for (const l of [...stashListeners]) l();
}

/** Subscribe to stash changes (SharePage preview, composer pickup). */
export function onShareStashChanged(cb: () => void): () => void {
  stashListeners.add(cb);
  return () => {
    stashListeners.delete(cb);
  };
}

/** Stage a payload, optionally already routed to its destination. */
export function stashShare(payload: SharePayload, route: string | null): void {
  stash = { payload, route };
  emitStashChanged();
}

/** SharePage's pick: routes the pending payload to the chosen conversation. */
export function assignShareRoute(route: string): void {
  if (!stash) return;
  stash = { ...stash, route };
  emitStashChanged();
}

/** The payload still awaiting a destination (what SharePage previews). */
export function pendingSharePreview(): SharePayload | null {
  return stash && stash.route === null ? stash.payload : null;
}

/**
 * Hand the payload to the composer serving `route`, so only the conversation
 * the share was routed to takes it.
 *
 * `route` is the composer's OWN room path, which the surface rendering it
 * passes down — never the ambient `window.location`. More than one composer is
 * mounted at a time (a route transition keeps the previous page alive while
 * the destination's chunk loads, and a thread panel has one of its own beside
 * the room's), and they would all read the same location: matching on it let
 * whichever composer happened to be mounted claim a payload addressed to the
 * conversation being navigated TO, pasting the share into the screen the user
 * was leaving. A composer with no route of its own (the thread panel) is not a
 * share destination and consumes nothing.
 */
export function consumeShareFor(route: string | undefined): SharePayload | null {
  if (!route || !stash || stash.route === null || stash.route !== route) return null;
  const { payload } = stash;
  stash = null;
  emitStashChanged();
  return payload;
}

/** Drop the pending share (user dismissed the picker). */
export function discardShare(): void {
  if (!stash) return;
  stash = null;
  emitStashChanged();
}

// ── Native share resolution ──────────────────────────────────────────────────

/**
 * Whether a tapped Direct Share shortcut id is a route a composer actually
 * mounts at. Requires a ROOM (a peer / group / channel): community- or
 * list-level routes redirect on mount, which would strand the path-matched
 * payload. Anything else falls back to the /share picker.
 */
export function isShareableRoomRoute(path: string): boolean {
  const route = parseChatRoute(path);
  if (!route) return false;
  switch (route.kind) {
    case "dm":
      return !!route.peer;
    case "nip29":
      return !!route.groupId;
    case "concord":
      return !!route.channelId;
  }
}

async function sharedFileToFile(meta: SharedFileMeta): Promise<File | null> {
  try {
    const res = await fetch(Capacitor.convertFileSrc(meta.path));
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], meta.name, { type: meta.type || blob.type });
  } catch {
    return null;
  }
}

/**
 * Consume the staged native share into the stash: text merged (subject first,
 * mirroring the Web Share Target merge), streams fetched out of the app cache
 * into File objects the upload pipeline accepts. Returns the route the share
 * flow should land on, or null when nothing was staged.
 */
export async function resolveNativeShare(): Promise<string | null> {
  const res = await ShareTarget.checkShare();
  if (!res.pending) return null;
  const files = (await Promise.all((res.files ?? []).map(sharedFileToFile))).filter(
    (f): f is File => f !== null,
  );
  const parts: string[] = [];
  if (res.subject && !(res.text ?? "").includes(res.subject)) parts.push(res.subject);
  if (res.text) parts.push(res.text);
  const route =
    res.shortcutId && isShareableRoomRoute(res.shortcutId) ? res.shortcutId : null;
  stashShare({ text: parts.join("\n"), files }, route);
  return route ?? "/share";
}

// ── Cold-launch share (mirrors coldLaunchDeepLink) ───────────────────────────
//
// A share intent can be the LAUNCH intent (process was dead). Like a cold
// deep link, its destination must be known before HomeRedirect commits `/` to
// the default server — so the destination is peeked ONCE at module load and
// HomeRedirect waits for it. Only the peek gates the redirect: the payload
// itself (checkShare, with its stream copies) resolves in the background and
// reaches the composer through the stash subscription whenever it's ready.

let coldResolved = !hasShareTarget();
let coldShareRoute: string | null = null;
const coldWaiters = new Set<() => void>();
const lateColdWaiters = new Set<(route: string) => void>();

function settleColdShare(route: string | null): void {
  if (coldResolved) return;
  coldShareRoute = route;
  coldResolved = true;
  for (const w of coldWaiters) w();
  coldWaiters.clear();
}

if (hasShareTarget()) {
  // Guard so a hung bridge can't pin HomeRedirect forever (same reasoning as
  // coldLaunchDeepLink's 1.5s guard; longer, because a share cold boot is
  // exactly when the bridge is busiest and a late peek costs a visible
  // default-screen flash before the late-route navigation below).
  const timeout = setTimeout(() => settleColdShare(null), 3000);
  ShareTarget.peekShare()
    .then((res) => {
      clearTimeout(timeout);
      if (!res.pending) {
        settleColdShare(null);
        return;
      }
      const route =
        res.shortcutId && isShareableRoomRoute(res.shortcutId) ? res.shortcutId : "/share";
      if (!coldResolved) {
        settleColdShare(route);
      } else {
        // The guard already fired and HomeRedirect committed to the default
        // route — hand the destination to the late listeners
        // (useShareTargetNavigation) instead of dropping it: the payload
        // below would otherwise land in the stash with nothing ever
        // navigating to the composer that consumes it.
        for (const w of lateColdWaiters) w(route);
      }
      // Payload in the background; the stash subscribers pick it up.
      void resolveNativeShare().catch(() => undefined);
    })
    .catch(() => {
      clearTimeout(timeout);
      settleColdShare(null);
    });
}

/** True until the launch intent has been peeked — HomeRedirect holds. */
export function coldSharePending(): boolean {
  return !coldResolved;
}

/** The cold-launch share destination (consumed once), or null. */
export function consumeColdShareRoute(): string | null {
  const r = coldShareRoute;
  coldShareRoute = null;
  return r;
}

/** Run `cb` once the launch intent is peeked (immediately if already). */
export function onColdShareResolved(cb: () => void): () => void {
  if (coldResolved) {
    cb();
    return () => undefined;
  }
  coldWaiters.add(cb);
  return () => {
    coldWaiters.delete(cb);
  };
}

/**
 * Run `cb` if the launch-intent peek resolves to a share AFTER the guard has
 * already released HomeRedirect (which then owns no navigation any more —
 * it's unmounted). The subscriber applies the route as an ordinary in-router
 * navigation (mirrors coldLaunchDeepLink's onLateColdLaunchDeepLink).
 */
export function onLateColdShareRoute(cb: (route: string) => void): () => void {
  lateColdWaiters.add(cb);
  return () => {
    lateColdWaiters.delete(cb);
  };
}
