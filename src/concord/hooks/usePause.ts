import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { citationFor, invalidateControl, publishEdition, useControlFold } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { activePause, buildSignalsEdition, type ActivePause } from "@/concord/lib/control";
import { bytesToHex, signalLocator } from "@/concord/lib/derive";
import { SIGNAL_PAUSE } from "@/concord/lib/kinds";
import { isAuthorized, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { toast } from "@/hooks/useToast";

/** `setTimeout`'s ceiling — anything larger fires immediately, so long waits re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The durations the pause control offers. Bounded by default, deliberately:
 * CORD-04 §8's `until` is the safety valve that lets a raid response survive
 * the pauser going offline before they can lift it, and a client that can only
 * mint an open-ended pause makes that valve unreachable. Under a full freeze
 * that matters more, not less — an unattended pause leaves every member,
 * staff included, with no chat wire at all until another MANAGE_CHANNELS
 * holder acts. `undefined` is the explicit open-ended choice.
 */
export const PAUSE_DURATIONS: ReadonlyArray<{ label: string; secs?: number }> = [
  { label: "15 minutes", secs: 15 * 60 },
  { label: "1 hour", secs: 60 * 60 },
  { label: "8 hours", secs: 8 * 60 * 60 },
  { label: "Until I resume it" },
];

/**
 * The community's active pause, re-evaluated when its `until` passes.
 *
 * CORD-04 §8 requires honoring `until` locally rather than waiting for a
 * clearing edition, and that means SCHEDULING the expiry — comparing at render
 * is not enough, because on a bounded pause nothing else re-renders on its
 * behalf: the fold doesn't change and no edition arrives. A frozen room whose
 * `until` passed unobserved is indistinguishable to its members from one
 * nobody lifted.
 */
export function useActivePause(community: Community | undefined): ActivePause | undefined {
  const { data: folded } = useControlFold(community);
  const [tick, setTick] = useState(0);
  const pause = activePause(folded, Math.floor(Date.now() / 1000));
  const until = pause?.until;

  useEffect(() => {
    if (until === undefined) return;
    // +1s so the wake lands strictly PAST the boundary: `activePause` clears at
    // `nowSec >= until`, and firing a few ms early would re-arm in a loop.
    const ms = until * 1000 - Date.now() + 1000;
    if (ms <= 0) return; // already inert; `pause` is undefined and this won't run
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(ms, MAX_TIMEOUT_MS));
    return () => clearTimeout(t);
    // `tick` re-arms the clamped case (an `until` further out than setTimeout
    // can express) and is otherwise a no-op: the wake that changes `pause`
    // clears `until`, which ends the loop.
  }, [until, tick]);

  return pause;
}

/**
 * The community-wide PAUSE signal (CORD-04 §8, `signal_id` "pause"): a
 * MANAGE_CHANNELS holder closes the room to non-staff. Enforcement is a
 * reader-side fold — the composer disables and non-staff messages collapse
 * (`activePause` + `foldTimeline`) — never an author drop. A pause carries an
 * optional `until` (seconds) that self-clears, so a raid response survives the
 * pauser going offline before they can lift it.
 */
export function useCommunityPause(community: Community | undefined): {
  /** Whether the reading user may pause/unpause (holds MANAGE_CHANNELS). */
  canPause: boolean;
  /** The active pause, or undefined. */
  pause: ActivePause | undefined;
  isPaused: boolean;
  /** Pause the community, optionally until `untilSecs` (unix seconds). */
  setPaused: ReturnType<typeof useMutation<void, Error, { untilSecs?: number }>>;
  /** Lift an active pause. */
  clearPause: ReturnType<typeof useMutation<void, Error, void>>;
} {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);

  const canPause = Boolean(
    user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.MANAGE_CHANNELS),
  );
  const pause = useActivePause(community);

  const publishPause = async (content: Record<string, unknown>): Promise<void> => {
    if (!user || !community) throw new Error("Not ready.");
    if (!folded || !isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.MANAGE_CHANNELS)) {
      throw new Error("You don't have permission to pause this community.");
    }
    const head = folded.heads.get(bytesToHex(signalLocator(community.id, SIGNAL_PAUSE)));
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildSignalsEdition(community.id, SIGNAL_PAUSE, content, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    );
    invalidateControl(queryClient, community.idHex);
  };

  const setPaused = useMutation<void, Error, { untilSecs?: number }>({
    mutationFn: ({ untilSecs }) =>
      publishPause({ paused: true, ...(untilSecs !== undefined ? { until: untilSecs } : {}) }),
    onError: (e) => toast({ title: "Couldn't pause the community", description: e.message }),
  });
  const clearPause = useMutation<void, Error, void>({
    mutationFn: () => publishPause({ paused: false }),
    onError: (e) => toast({ title: "Couldn't resume the community", description: e.message }),
  });

  return { canPause, pause, isPaused: Boolean(pause), setPaused, clearPause };
}
