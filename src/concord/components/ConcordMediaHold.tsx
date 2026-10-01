import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { MediaHoldContext, type MediaHold } from "@/components/chat/mediaHold";
import { useChatModeration } from "@/concord/hooks/useChannel";
import {
  holdsAvatar,
  holdsMedia,
  nextEstablishedAt,
  readSightings,
  sightingsRevision,
  subscribeSightings,
} from "@/concord/lib/mediaTrust";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useFollowList } from "@/hooks/useFollowList";

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
  const mode = useAppContext().config.communityMediaAutoload;
  const { user } = useCurrentUser();
  const { isStaff } = useChatModeration(community);
  const followPubkeys = useFollowList().data?.pubkeys;
  const follows = useMemo(() => new Set(followPubkeys ?? []), [followPubkeys]);
  const stableTrusted = useStableSet(trusted);

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

  const self = user?.pubkey;
  const holds = useMemo<MediaHold>(() => {
    // `now` re-memoizes on a probation crossing; the predicates read the clock themselves.
    void now;
    const inputs = () => ({ mode, self, isStaff, trusted: stableTrusted, follows, sightings, now: Date.now() });
    return {
      media: (author) => holdsMedia(author, inputs()),
      avatar: (author) => holdsAvatar(author, inputs()),
    };
  }, [mode, self, isStaff, stableTrusted, follows, sightings, now]);

  return <MediaHoldContext.Provider value={holds}>{children}</MediaHoldContext.Provider>;
}
