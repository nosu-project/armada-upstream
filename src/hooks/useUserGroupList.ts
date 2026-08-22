import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import {
  buildGroupListTags,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
  type UserGroupList,
} from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import { queryExplicitRelaysWithStatus } from "@/lib/nip65";

import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Empty list, used before any 10009 event exists. */
const EMPTY_LIST: UserGroupList = { groups: [], servers: [] };

/** Result of reading a 10009 event, with a flag for a failed private-item decrypt. */
export interface ReadGroupListResult extends UserGroupList {
  /**
   * True when the event had encrypted private items but decryption failed (no
   * signer, signer refused, or transient error). The parsed list is then only
   * the public tags — which are usually empty — so callers MUST NOT treat an
   * empty `servers`/`groups` as authoritative when this is set.
   */
  decryptFailed: boolean;
}

export interface UserGroupListQuery extends ReadGroupListResult {
  event: NostrRumor | null;
  /** True only when every current self-state relay completed the wire read. */
  wireReady?: boolean;
}

function eventWins(candidate: NostrRumor, held: NostrRumor): boolean {
  return candidate.created_at > held.created_at
    || (candidate.created_at === held.created_at && candidate.id < held.id);
}

/** NIP-01 replaceable winner: newest timestamp, then lexicographically lowest id. */
export function newestGroupListEvent(events: NostrRumor[]): NostrRumor | null {
  return events
    .filter((event) => event.kind === KIND_USER_GROUPS)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Resolve a relay refresh without regressing a previously decrypted list.
 * Empty/stale reads and an undecryptable candidate are "no news", not an
 * authoritative empty list. A genuinely newer, successfully decoded empty
 * event still wins, so an intentional clear propagates normally.
 */
export async function resolveGroupListRead(
  events: NostrRumor[],
  signer: NUser["signer"] | undefined,
  previous?: UserGroupListQuery,
  persisted?: PersistedGroupList,
): Promise<UserGroupListQuery> {
  let lastGood: UserGroupListQuery | undefined =
    previous?.event && !previous.decryptFailed ? previous : undefined;
  if (persisted?.event && (!lastGood?.event || eventWins(persisted.event, lastGood.event))) {
    lastGood = {
      event: persisted.event,
      groups: persisted.groups,
      servers: persisted.servers,
      decryptFailed: false,
    };
  }

  const latest = newestGroupListEvent(events);
  if (!latest) return lastGood ?? { event: null, ...EMPTY_LIST, decryptFailed: false };
  if (lastGood?.event && latest.id !== lastGood.event.id && !eventWins(latest, lastGood.event)) {
    return lastGood;
  }
  if (lastGood?.event?.id === latest.id) return lastGood;

  const decoded = await readGroupListEvent(latest, signer);
  if (decoded.decryptFailed && lastGood) return lastGood;
  return { event: latest, ...decoded };
}

/**
 * Decode-once cache for the 10009 private-items decrypt, keyed by event id.
 * `useUserGroupList` is mounted by several always-on surfaces (NostrSync,
 * notifications, badge), and each seed effect / queryFn would otherwise run the
 * full NIP-44 decrypt of the same event independently — which on a remote/
 * extension signer costs seconds EACH. The event id + content are immutable, so
 * a single in-flight decrypt is shared and reused for the session.
 */
const groupListDecryptMemo = new Map<string, Promise<ReadGroupListResult>>();

/**
 * Decrypt the NIP-44 private items of a kind 10009 event (NIP-51) and merge
 * them with the public tags. Private items live in `.content` as a stringified
 * tag array, encrypted to self. Falls back to public-only when there is no
 * signer or decryption fails. Memoized by event id so concurrent callers share
 * one signer round-trip.
 */
export async function readGroupListEvent(
  event: NostrRumor | null,
  signer: NUser["signer"] | undefined,
): Promise<ReadGroupListResult> {
  if (!event) return { ...EMPTY_LIST, decryptFailed: false };
  // No encrypted content → pure public-tag parse, no signer needed.
  if (!event.content) return { ...parseGroupListTags([...event.tags]), decryptFailed: false };
  // Encrypted items present but no signer to read them.
  if (!signer?.nip44) return { ...parseGroupListTags([...event.tags]), decryptFailed: true };

  const cached = groupListDecryptMemo.get(event.id);
  if (cached) return cached;

  const nip44 = signer.nip44;
  const work = (async (): Promise<ReadGroupListResult> => {
    const tags = [...event.tags];
    try {
      const decrypted = await nip44.decrypt(event.pubkey, event.content);
      const privateTags = JSON.parse(decrypted);
      if (Array.isArray(privateTags)) {
        for (const tag of privateTags) {
          if (Array.isArray(tag)) tags.push(tag as string[]);
        }
      }
      return { ...parseGroupListTags(tags), decryptFailed: false };
    } catch (err) {
      console.warn("Failed to decrypt group list private items:", err);
      groupListDecryptMemo.delete(event.id); // don't memoize a transient failure
      return { ...parseGroupListTags(tags), decryptFailed: true };
    }
  })();
  groupListDecryptMemo.set(event.id, work);
  return work;
}

/**
 * The user's kind 10009 group list (NIP-51 "Simple groups"). This is the
 * cross-device source of truth for both joined channels (`group` tags) and the
 * servers the user has added (`r` tags). Private items are NIP-44 encrypted to
 * self in `.content`.
 */
export function useUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["nip29", "user-groups", user?.pubkey];
  const foldKey = user ? groupListFoldKey(user.pubkey) : null;

  // Plaintext-first (Vector-style): the 10009 private items are NIP-44
  // self-encrypted, and decrypting them through a remote/extension signer on
  // every boot is slow (seconds on a bunker) — which stalls discovery of WHICH
  // groups/relays to load, gating the whole NIP-29 UI. So we decrypt ONCE,
  // persist the DECRYPTED list locally (same device-trust as the keys it
  // holds), and read that plaintext on every subsequent boot — no signer call.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;

      // 1. Plaintext-first: a previously-decrypted list paints instantly.
      const persisted = await readFolded<PersistedGroupList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        queryClient.setQueryData(queryKey, {
          event: persisted.event ?? null,
          groups: persisted.groups,
          servers: persisted.servers,
          decryptFailed: false,
        });
        return;
      }

      // 2. First run / no plaintext yet: decrypt the cached blob once, persist it.
      const store = await eventStore;
      const cached = newestGroupListEvent(
        await store.query([{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey] }]),
      );
      if (cancelled || !cached) return;
      const list = await readGroupListEvent(cached, user.signer);
      if (cancelled || queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, {
        event: cached,
        groups: list.groups,
        servers: list.servers,
        decryptFailed: list.decryptFailed,
      });
      if (!list.decryptFailed) {
        void writeFolded(foldKey, {
          event: cached,
          groups: list.groups,
          servers: list.servers,
        } satisfies PersistedGroupList);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, eventStore, queryClient]);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      const selfRelays = [
        ...new Set(selfStateRelays(config, user!.pubkey)
          .map(normalizeRelayUrl)
          .filter((url): url is string => Boolean(url))),
      ].sort();
      const [wireRead, storedEvents] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          selfRelays,
          [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey], limit: 1 }],
          deadline,
        ),
        eventStore
          .then((store) => store.query(
            [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey] }],
            { signal: deadline },
          ))
          .catch(() => [] as NostrRumor[]),
      ]);
      const prev = queryClient.getQueryData<UserGroupListQuery>(queryKey);
      const persisted = foldKey
        ? await readFolded<PersistedGroupList>(foldKey)
        : undefined;
      const newestWire = newestGroupListEvent(
        wireRead.events.filter((event) => event.pubkey === user!.pubkey),
      );
      const wireDecryptReady = newestWire
        ? !(await readGroupListEvent(newestWire, user!.signer)).decryptFailed
        : true;
      const result = await resolveGroupListRead(
        [...wireRead.events, ...storedEvents].filter((event) => event.pubkey === user!.pubkey),
        user!.signer,
        prev,
        persisted,
      );
      // Persist the decrypted result so the NEXT boot reads plaintext (no signer).
      if (foldKey && result.event && !result.decryptFailed) {
        void writeFolded(foldKey, {
          event: result.event,
          groups: result.groups,
          servers: result.servers,
        } satisfies PersistedGroupList);
      }
      const answered = new Set(wireRead.answered);
      return {
        ...result,
        // With no explicit authority, the pool-wide fallback cannot prove
        // which source failed; it is useful additive data, never prune proof.
        wireReady: selfRelays.length > 0
          && selfRelays.every((relay) => answered.has(relay))
          && wireDecryptReady,
      };
    },
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

/** A single mutation against the user's kind 10009 list (read-modify-write). */
type GroupListAction =
  | { type: "add-group"; ref: GroupRef }
  | { type: "remove-group"; ref: GroupRef }
  | { type: "add-server"; url: string }
  | { type: "remove-server"; url: string }
  | { type: "reorder-servers"; urls: string[] };

function applyAction(list: UserGroupList, action: GroupListAction): UserGroupList {
  switch (action.type) {
    case "add-group": {
      const without = list.groups.filter(
        (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
      );
      // Joining a channel is the explicit action that brings its server into
      // the cross-device list too (there is no passive-visit server sync).
      const relay = normalizeRelayUrl(action.ref.relay) ?? action.ref.relay;
      const servers = list.servers.some((s) => (normalizeRelayUrl(s) ?? s) === relay)
        ? list.servers
        : [...list.servers, relay];
      return { ...list, groups: [...without, action.ref], servers };
    }
    case "remove-group":
      return {
        ...list,
        groups: list.groups.filter(
          (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
        ),
      };
    case "add-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      if (list.servers.includes(url)) return list;
      return { ...list, servers: [...list.servers, url] };
    }
    case "remove-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      // Compare by normalized url so a stored `r` tag that differs only
      // superficially (trailing slash / casing — `parseGroupListTags` keeps
      // the raw tag) is still dropped, rather than surviving to re-hydrate the
      // rail on the next boot.
      //
      // Also drop every joined `group` on this server: removing a server means
      // leaving its channels, and a surviving `group` tag would keep
      // re-hydrating them on other devices. The server only comes back if the
      // user explicitly (re)joins a channel on it (`add-group` carries the
      // server) or re-adds it.
      return {
        ...list,
        servers: list.servers.filter((s) => (normalizeRelayUrl(s) ?? s) !== url),
        groups: list.groups.filter((g) => (normalizeRelayUrl(g.relay) ?? g.relay) !== url),
      };
    }
    case "reorder-servers": {
      // Reorder the existing servers to match `urls`. Normalize and dedupe the
      // incoming order, keep only servers already in the list (so a stale
      // reorder can't add/drop entries), then append any servers the caller
      // omitted to avoid silently losing them.
      const known = new Set(list.servers);
      const desired: string[] = [];
      const seen = new Set<string>();
      for (const raw of action.urls) {
        const url = normalizeRelayUrl(raw) ?? raw;
        if (known.has(url) && !seen.has(url)) {
          seen.add(url);
          desired.push(url);
        }
      }
      for (const url of list.servers) {
        if (!seen.has(url)) desired.push(url);
      }
      return { ...list, servers: desired };
    }
  }
}

/**
 * All 10009 writes run one at a time, process-wide.
 *
 * Every write is a read-modify-write spanning an 8s network read, a signer
 * round-trip and a publish. Fired concurrently — which is exactly what
 * removing several servers in a row does, one context-menu click each — they
 * all read the SAME pre-edit list, each drops only its own server, and the
 * last publish to land overwrites the rest. Five removals would keep one.
 * Serializing makes each write observe the previous one's result.
 */
let groupListWriteChain: Promise<unknown> = Promise.resolve();

function serializeGroupListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = groupListWriteChain.then(write, write);
  // Swallow the result on the chain itself so one failed write neither wedges
  // the queue nor surfaces as an unhandled rejection; the caller still gets it.
  groupListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * The created_at for the next version of a replaceable event.
 *
 * Replaceable events are ordered at SECOND granularity, and NIP-01 breaks a
 * created_at tie by lowest event id — so two writes within the same second
 * resolve arbitrarily and the later edit can lose to the earlier one. Force
 * strict monotonicity instead of trusting the wall clock.
 */
function nextCreatedAt(prev: NostrRumor | null): number {
  const now = Math.floor(Date.now() / 1000);
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Mutate the user's kind 10009 list (add/remove a group or a server) with a
 * read-modify-write against fresh relay state. New lists store items as
 * NIP-44 private items (encrypted to self) in `.content`, matching NIP-51;
 * an existing list keeps whichever format (public tags vs encrypted content)
 * it already uses.
 */
export function useUpdateUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    mutationFn: (action: GroupListAction) => serializeGroupListWrite(async () => {
      if (!user) throw new Error("User is not logged in");

      // Read-modify-write against fresh relay state, never the query cache.
      const relays = selfStateRelays(config, user.pubkey);
      if (relays.length === 0) {
        throw new Error("No account-state relay is available for your server list");
      }
      const deadline = AbortSignal.timeout(8000);
      const [response, storedEvents] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        eventStore
          .then((store) => store.query(
            [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey] }],
            { signal: deadline },
          ))
          .catch(() => [] as NostrRumor[]),
      ]);
      if (response.answered.length === 0) {
        throw new Error(
          "Couldn't confirm your current server list on an account-state relay; not saving to avoid wiping it.",
        );
      }
      const events = [...response.events, ...storedEvents];
      const fetched = newestGroupListEvent(events);

      // The locally-persisted DECRYPTED list is the safety net for two relay
      // failure modes that a bare network read can't distinguish from "the
      // user has no list yet":
      //
      //  1. The read returns NOTHING (cold pool, AUTH-gated relay, wrong relay
      //     set) but this device has seen a list before. Building on "empty"
      //     would publish a list that wipes every server and joined group the
      //     user has. Refuse the write instead — no publish is always
      //     recoverable; a wiped replaceable event is not.
      //  2. The read returns an event OLDER than one this device already holds
      //     (stale replaceable-event propagation). Base the edit on the newer
      //     persisted copy so the publish doesn't silently revert the user's
      //     recent changes.
      const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(user.pubkey));
      if (!fetched && persisted?.event) {
        throw new Error("Couldn't load your current server list from the network; not saving to avoid wiping it.");
      }

      let prev: NostrRumor | null = fetched;
      let current: UserGroupList;
      // Pick the actual NIP-01 replaceable winner. Strictly-increasing local
      // writes make the serialized predecessor newer by timestamp; a genuine
      // equal-second collision must use the protocol's lowest-id tiebreak or
      // the edit can be based on a version no conforming relay will retain.
      if (persisted?.event && fetched && (
        persisted.event.id === fetched.id || eventWins(persisted.event, fetched)
      )) {
        prev = persisted.event;
        current = { groups: persisted.groups, servers: persisted.servers };
      } else {
        const read = await readGroupListEvent(fetched, user.signer);
        // Refuse to read-modify-write on top of a list we couldn't decrypt: the
        // private items (servers + joined groups) would read as empty and we'd
        // publish a list that wipes everything the user has. Better to fail the
        // action than to silently destroy their server/group list.
        if (read.decryptFailed) {
          throw new Error("Couldn't read your existing list (decryption failed); not saving to avoid data loss.");
        }
        current = read;
      }
      const next = applyAction(current, action);

      // Preserve any unrelated tags (title, etc.) from the previous event; the
      // group/r items are re-emitted below in whichever format the list uses.
      const otherTags =
        prev?.tags.filter(([name]) => name !== "group" && name !== "r") ?? [];

      // Preserve the FORMAT the existing list already uses. A list published
      // unencrypted (public `group`/`r` tags — e.g. by Flotilla/Coracle) stays
      // public: silently re-encrypting it into `.content` blanks the list for
      // every other client that reads the public tags. An encrypted list stays
      // encrypted (never downgrade private items to public — that would leak
      // them). Only a brand-new list defaults to Armada's native
      // encrypted-private-items format.
      const writePrivate = prev ? Boolean(prev.content) : true;
      const itemTags = buildGroupListTags(next);
      let content = "";
      let tags = otherTags;
      if (writePrivate) {
        if (!user.signer.nip44) {
          throw new Error("NIP-44 encryption not supported by this signer");
        }
        content = await user.signer.nip44.encrypt(
          user.pubkey,
          JSON.stringify(itemTags),
        );
      } else {
        tags = [...otherTags, ...itemTags];
      }

      const published = await publishEvent({
        kind: KIND_USER_GROUPS,
        content,
        tags,
        created_at: nextCreatedAt(prev),
        prev: prev ?? undefined,
        relays: response.answered,
        inheritPendingTargets: false,
      });
      // Persist the decrypted result (we have `next` in the clear here) so the
      // next boot reads plaintext without a signer decrypt. AWAITED, not fired
      // and forgotten: the next queued write reads this back as its base, and
      // a write that hasn't landed yet would send it to the stale network copy
      // and undo this edit.
      if (published) {
        await writeFolded(groupListFoldKey(user.pubkey), {
          event: published,
          groups: next.groups,
          servers: next.servers,
        } satisfies PersistedGroupList).catch(() => undefined);
      }
      return published;
    }),
    onSuccess: (_published, action) => {
      // Removing a server also purges its rail-arrangement key. Doing it here
      // rather than at each menu item means every removal surface is covered,
      // and only once the list write actually landed.
      if (action.type === "remove-server") {
        removeRailKey(normalizeRelayUrl(action.url) ?? action.url);
      }
      queryClient.invalidateQueries({ queryKey: ["nip29", "user-groups"] });
    },
  });
}
