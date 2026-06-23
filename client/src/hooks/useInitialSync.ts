import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  KIND_GROUP_CHAT,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
} from "@/lib/nip29";
import { EncryptedSettingsSchema } from "@/lib/schemas";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-78 application-data kind (Armada's encrypted settings). */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";
/** NIP-88 poll kind — polls render inline in the group timeline. */
const KIND_POLL = 1068;
/** Kinds shown in a group timeline (mirrors useGroupMessages). */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** How many messages to catch up per channel (mirrors useGroupMessages PAGE_SIZE). */
const PAGE_SIZE = 50;
/** Cap on channels we eagerly catch up, so a user in dozens of groups isn't blocked forever. */
const MAX_CATCHUP_CHANNELS = 8;

/** Overall timeout for the whole sync so a dead relay never traps the user. */
const SYNC_TIMEOUT_MS = 12_000;
/** Per-step network timeout. */
const STEP_TIMEOUT_MS = 8_000;

/** A phase of the post-login sync, used to render a live status line. */
export type SyncPhase = "settings" | "groups" | "messages" | "done";

export interface SyncState {
  phase: SyncPhase;
  /** Human-readable status line, e.g. "Catching up on messages…". */
  label: string;
  /** True once the sync has finished (or timed out). */
  done: boolean;
}

const PHASE_LABEL: Record<SyncPhase, string> = {
  settings: "Syncing your settings…",
  groups: "Loading your channels…",
  messages: "Catching up on messages…",
  done: "Done",
};

function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Runs the one-time post-login sync for `pubkey` and reports live progress:
 *
 *   1. Pull encrypted settings (NIP-78, kind 30078, d="armada/metadata") and
 *      seed the `["encrypted-settings", pubkey]` cache so NostrSync applies
 *      theme/relay config without a second fetch.
 *   2. Pull the kind 10009 group list (joined channels + servers) and seed the
 *      `["nip29","user-groups",pubkey]` cache.
 *   3. Catch up on the newest page of messages for each joined channel (capped),
 *      priming the same caches useGroupMessages reads so timelines render
 *      instantly once the gate lifts.
 *
 * Every step is best-effort and bounded by a timeout — the gate must never trap
 * a user behind a slow or unreachable relay. Returns `{ phase, label, done }`.
 * Pass `pubkey === undefined` to stay idle (done immediately).
 */
export function useInitialSync(pubkey: string | undefined): SyncState {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const [state, setState] = useState<SyncState>({
    phase: "settings",
    label: PHASE_LABEL.settings,
    done: pubkey === undefined,
  });

  // Guard so we run the sequence exactly once per fresh pubkey.
  const ranForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pubkey) {
      setState({ phase: "done", label: PHASE_LABEL.done, done: true });
      return;
    }
    // Wait until the signer for this pubkey is the active user (settings + the
    // group list need NIP-44 to decrypt). Until then, keep showing the spinner.
    if (!user || user.pubkey !== pubkey) return;
    if (ranForRef.current === pubkey) return;
    ranForRef.current = pubkey;

    let cancelled = false;
    const overall = AbortSignal.timeout(SYNC_TIMEOUT_MS);

    const setPhase = (phase: SyncPhase) => {
      if (!cancelled) setState({ phase, label: PHASE_LABEL[phase], done: phase === "done" });
    };

    const stepSignal = () => AbortSignal.any([overall, AbortSignal.timeout(STEP_TIMEOUT_MS)]);

    void (async () => {
      // ── 1. Encrypted settings ───────────────────────────────────────────
      setPhase("settings");
      try {
        if (user.signer.nip44) {
          const events = await nostr.query(
            [{ kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 }],
            { signal: stepSignal() },
          );
          const event = events.sort((a, b) => b.created_at - a.created_at)[0];
          if (event?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, event.content);
            const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
            if (parsed.success && !cancelled) {
              queryClient.setQueryData(["encrypted-settings", pubkey], parsed.data);
            }
          }
        }
      } catch {
        // Best-effort; fall through to the next step.
      }
      if (cancelled) return;

      // ── 2. Group list (kind 10009) ──────────────────────────────────────
      setPhase("groups");
      let groups: GroupRef[] = [];
      try {
        const events = await nostr.query(
          [{ kinds: [KIND_USER_GROUPS], authors: [pubkey], limit: 1 }],
          { signal: stepSignal() },
        );
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        if (latest) {
          const tags = [...latest.tags];
          if (latest.content && user.signer.nip44) {
            try {
              const decrypted = await user.signer.nip44.decrypt(pubkey, latest.content);
              const privateTags = JSON.parse(decrypted);
              if (Array.isArray(privateTags)) {
                for (const t of privateTags) if (Array.isArray(t)) tags.push(t as string[]);
              }
            } catch {
              // Public-only fallback.
            }
          }
          const list = parseGroupListTags(tags);
          groups = list.groups;
          if (!cancelled) {
            queryClient.setQueryData(["nip29", "user-groups", pubkey], {
              event: latest,
              groups: list.groups,
              servers: list.servers,
            });
          }
        }
      } catch {
        // Best-effort.
      }
      if (cancelled) return;

      // ── 3. Catch up on messages for joined channels ─────────────────────
      setPhase("messages");
      const channels = groups.slice(0, MAX_CATCHUP_CHANNELS);
      if (channels.length > 0) {
        await Promise.all(
          channels.map(async ({ id, relay }) => {
            try {
              const events = await nostr.relay(relay).query(
                [{ kinds: TIMELINE_KINDS, "#h": [id], limit: PAGE_SIZE }],
                { signal: stepSignal() },
              );
              if (cancelled || events.length === 0) return;
              const sorted = sortDedupe(events);
              queryClient.setQueryData<NostrEvent[]>(["nip29", "messages", relay, id], (old) =>
                old && old.length > 0 ? old : sorted,
              );
              queryClient.setQueryData<string[]>(
                ["nip29", "msg-ids", relay, id],
                sorted.map((e) => e.id),
              );
            } catch {
              // Best-effort per channel.
            }
          }),
        );
      }
      if (cancelled) return;

      // NOTE: we deliberately do NOT write the settings sync watermark here.
      // NostrSync owns applying the fetched settings (theme/relay config) into
      // AppConfig and only then records the watermark; writing it now would make
      // NostrSync's timestamp guard skip the very settings we just primed. The
      // "don't re-gate on reload" behavior is handled by useFreshLogin instead.
      setPhase("done");
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, user, nostr, queryClient]);

  return state;
}
