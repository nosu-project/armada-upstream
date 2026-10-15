/**
 * How THIS device presents a forum channel (CORD-03 §2 `view: "forum"`): the
 * feed of titled posts by default, or the plain timeline for channels the user
 * flipped to "View as chat". One store, so the page and every unread scan agree
 * on what the reader can actually see.
 */

import { useSyncExternalStore } from "react";

import type { ChannelView } from "@/concord/lib/types";

const KEY = "armada:concord-forum-as-chat";
const EMPTY: ReadonlySet<string> = new Set();

let cachedRaw: string | null = null;
let cached: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Channel ids shown as chat. Keyed on the stored string, so a purge or another tab is seen. */
export function forumAsChatIds(): ReadonlySet<string> {
  const raw = readRaw();
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cached = Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function toggleForumAsChat(channelIdHex: string): void {
  const next = new Set(forumAsChatIds());
  if (next.has(channelIdHex)) next.delete(channelIdHex);
  else next.add(channelIdHex);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch { /* storage full or unavailable: the flip just doesn't persist */ }
  for (const listener of listeners) listener();
}

export function useForumAsChatIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, forumAsChatIds, () => EMPTY);
}

/**
 * Whether the channel opens as the titled-post feed on this device, where an
 * untitled message (`isTitledPost` false) is never shown and so never unread.
 */
export function showsAsFeed(channel: { idHex: string; view?: ChannelView }, asChat: ReadonlySet<string>): boolean {
  return channel.view === "forum" && !asChat.has(channel.idHex);
}
