import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { MediaHoldContext, type MediaHold } from "@/components/chat/mediaHold";
import { useChatModeration } from "@/concord/hooks/useChannel";
import {
  holdsMedia,
  holdsMediaUrl,
  nextEstablishedAt,
  readSightings,
  sightingsRevision,
  sightingsVerdictsDiffer,
  subscribeSightings,
} from "@/concord/lib/mediaTrust";
import { useAppContext } from "@/hooks/useAppContext";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowList } from "@/hooks/useFollowList";
import { knownHostSet } from "@/lib/knownMediaHosts";

import type { Community } from "@/concord/lib/types";
import type { ReactNode } from "react";

const EMPTY: ReadonlySet<string> = new Set();

/** Same members ⇒ same reference, so a re-fold that trusts nobody new re-renders no body. */
function useStableSet(next: ReadonlySet<string> | undefined): ReadonlySet<string> {
  const ref = useRef<ReadonlySet<string>>(EMPTY);
  const value = next ?? EMPTY;
  const prev = ref.current;
  if (prev !== value && (prev.size !== value.size || [...value].some((v) => !prev.has(v)))) {
    ref.current = value;
  }
  return ref.current;
}

/** Holds untrusted authors' media for everything rendered inside one community. */
export function ConcordMediaHold({
  community,
  trusted,
  children,
}: {
  community: Community | undefined;
  /** The open channel's earned-trust set (`FoldedTimeline.trusted`). */
  trusted: ReadonlySet<string> | undefined;
  children: ReactNode;
}) {
  const {
    communityMediaAutoload: mode,
    communityMediaKnownHostsOnly: hostsOnly,
    trustedMediaHosts,
    mediaProxies,
  } = useAppContext().config;
  const proxied = mediaProxies.length > 0;
  const { user } = useCurrentUser();
  const { isStaff } = useChatModeration(community);
  const followPubkeys = useFollowList().data?.pubkeys;
  const follows = useMemo(() => new Set(followPubkeys ?? []), [followPubkeys]);
  const stableTrusted = useStableSet(trusted);
  const blossomServers = useBlossomServers();
  const knownHosts = useMemo(() => knownHostSet(blossomServers, trustedMediaHosts), [blossomServers, trustedMediaHosts]);

  const revision = useSyncExternalStore(subscribeSightings, sightingsRevision);
  const communityIdHex = community?.idHex;
  const sightings = useMemo(() => {
    void revision;
    return communityIdHex ? readSightings(communityIdHex) : undefined;
  }, [communityIdHex, revision]);

  // Wake when the next author leaves probation; nothing else re-renders for it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextEstablishedAt(sightings, now);
    if (at === undefined) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(t);
  }, [sightings, now]);

  // The record the predicate reads moves only when some verdict does. Re-checked on
  // every new record and probation crossing (`now`), so a held-back record is never
  // stale by a decision.
  const decidingRef = useRef(sightings);
  const deciding = useMemo(() => {
    void now;
    if (sightingsVerdictsDiffer(decidingRef.current, sightings, Date.now())) decidingRef.current = sightings;
    return decidingRef.current;
  }, [sightings, now]);

  const self = user?.pubkey;
  const holds = useMemo<MediaHold>(() => {
    // `now` re-memoizes on a probation crossing; the predicate reads the clock itself.
    void now;
    const inputs = () => ({ mode, self, isStaff, trusted: stableTrusted, follows, sightings: deciding, now: Date.now() });
    return {
      mode,
      media: (author) => holdsMedia(author, inputs()),
      host: (author, url) => hostsOnly && holdsMediaUrl(author, url, { self, proxied }, knownHosts),
    };
  }, [mode, hostsOnly, proxied, self, isStaff, stableTrusted, follows, deciding, now, knownHosts]);

  return <MediaHoldContext.Provider value={holds}>{children}</MediaHoldContext.Provider>;
}
