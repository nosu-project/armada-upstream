/**
 * One-shot kind-0 lookups for the push worker, for authors this device has
 * never stored. A worker lives for seconds per push, so each relay gets one
 * socket and one REQ, and is hung up on as soon as the answer is in.
 */

import { verifyEvent } from "nostr-tools/pure";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Short on purpose: the notification waits on it, and the OS binds the icon
 * when it first draws the row — a late name is a name nobody sees.
 */
export const PROFILE_FETCH_TIMEOUT_MS = 2500;
/** Relays asked at once. */
const RELAY_FANOUT = 4;

/**
 * The newest valid kind 0 per pubkey that the relays hand over within
 * `timeoutMs`, settling once every relay has answered; never rejects.
 * Every event is signature-checked: a relay's word is not a profile.
 */
export function fetchProfiles(
  relays: string[],
  pubkeys: string[],
  timeoutMs = PROFILE_FETCH_TIMEOUT_MS,
): Promise<NostrEvent[]> {
  const wanted = new Set(pubkeys);
  const targets = [...new Set(relays.filter((url) => /^wss?:\/\//i.test(url)))].slice(0, RELAY_FANOUT);
  if (wanted.size === 0 || targets.length === 0 || typeof WebSocket === "undefined") {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    const newest = new Map<string, NostrEvent>();
    const sockets: WebSocket[] = [];
    let pending = targets.length;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const ws of sockets) {
        try {
          ws.close();
        } catch { /* already gone */ }
      }
      resolve([...newest.values()]);
    };
    const timer = setTimeout(done, timeoutMs);

    for (const url of targets) {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (--pending <= 0) done();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        finish();
        continue;
      }
      sockets.push(ws);

      const subId = `sw-p-${Math.random().toString(36).slice(2, 10)}`;
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: [...wanted], limit: wanted.size }]));
        } catch {
          finish();
        }
      };
      ws.onmessage = (message) => {
        let frame: unknown;
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!Array.isArray(frame) || frame[1] !== subId) return;
        if (frame[0] === "EVENT") {
          const ev = frame[2] as NostrEvent | undefined;
          if (!ev || typeof ev !== "object" || ev.kind !== 0 || !wanted.has(ev.pubkey)) return;
          const prev = newest.get(ev.pubkey);
          if (prev && prev.created_at >= ev.created_at) return;
          if (!verifyEvent(ev)) return;
          newest.set(ev.pubkey, ev);
        } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
          finish();
        }
      };
      ws.onerror = finish;
      ws.onclose = finish;
    }
  });
}
