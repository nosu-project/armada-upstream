import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useControlEvents2 } from "@/concord-v2/hooks/useControlPlane2";
import { suspiciousActivity, type SuspiciousActor } from "@/concord-v2/lib/auditLog";
import { openControlEditions, type FoldedControl } from "@/concord-v2/lib/control";
import {
  controlSweepAnswered,
  controlSweepQuorum,
  controlSweepTruncated,
  controlSweepUnreadable,
  subscribeSweepVerdicts,
  sweepVerdictRevision,
} from "@/concord-v2/lib/planeSync";
import { Permissions, isAuthorized } from "@/concord-v2/lib/roles";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KvPrefixCache } from "@/lib/db/kvCache";

/**
 * How far back the watchdog looks. The alert is about activity happening NOW,
 * and the window also bounds a false positive the fold guarantees: authority is
 * judged as it stands TODAY, so demoting an admin retroactively makes their
 * whole history unauthorized. Without a window that would read as an attack the
 * moment anyone is demoted.
 */
const WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Unreadable events tolerated before they alone raise the alarm. Junk that
 * won't decrypt can't be attributed to anyone — the wrap's author IS the shared
 * plane key, and the real signer is inside the seal we can't open — so this
 * never names a culprit. It still warrants telling an admin, because it is the
 * cheapest way to inflate the plane and the only remedy is rotating the keys.
 */
const UNREADABLE_ALERT_THRESHOLD = 10;

/**
 * What a dismissal remembers. The timestamp silences named actors (their
 * editions fall behind the watermark), but the unreadable tally is a running
 * count with no timestamps to fall behind — so a junk-only alert needs its own
 * high-water mark, or "Understood" is a button that does nothing.
 */
interface Dismissal {
  at: number;
  unreadable: number;
  /** Whether the plane was already unreadably deep when they acknowledged it. */
  flooded?: boolean;
}

const NO_DISMISSAL: Dismissal = { at: 0, unreadable: 0, flooded: false };

/**
 * Dismissal watermarks, per (account, community), in ArmadaDB's KV behind a
 * synchronous cache — one entry per community the account has ever dismissed
 * an alert in, never evicted.
 *
 * Reads before the warm lands report "never dismissed", so the hook re-reads
 * once {@link dismissals.ready} resolves. The failure that costs is a banner
 * briefly reappearing, never a suppressed alert.
 */
const dismissals = new KvPrefixCache<Partial<Dismissal> | number>({ prefix: "cp-watchdog:" });

const dismissId = (me: string, idHex: string) => `${me}:${idHex}`;

function readDismissal(me: string, idHex: string): Dismissal {
  const stored = dismissals.get(dismissId(me, idHex));
  if (stored === undefined) return NO_DISMISSAL;
  // Older builds stored a bare timestamp.
  if (typeof stored === "number") return { at: stored, unreadable: 0, flooded: false };
  if (typeof stored !== "object" || stored === null) return NO_DISMISSAL;
  return {
    at: Number(stored.at) || 0,
    unreadable: Number(stored.unreadable) || 0,
    flooded: stored.flooded === true,
  };
}

function writeDismissal(me: string, idHex: string, next: Dismissal): void {
  if (me && idHex) dismissals.set(dismissId(me, idHex), next);
}

/**
 * Members writing control editions the fold refuses for lack of authority —
 * the signal that someone with no standing is trying to act, visible from
 * their FIRST attempt rather than once the plane is deep enough to starve a
 * sweep.
 *
 * Only reported to a viewer who can actually do something about it, and only
 * once a sweep has run its course: cut one off early and we may not have
 * fetched the grant that authorises someone, so they would look roleless purely
 * because their promotion hasn't been read yet.
 *
 * `folded` is passed in rather than re-derived: the fold decrypts and
 * Schnorr-verifies every control edition, and its owner already holds one.
 */
export function useSuspiciousActivity2(
  community: CommunityV2 | undefined,
  folded: FoldedControl | undefined,
  active = true,
) {
  const { user } = useCurrentUser();
  const control = useControlEvents2(community, active);
  const me = user?.pubkey ?? "";
  const idHex = community?.idHex ?? "";
  // Re-read per (account, community): the banner stays MOUNTED across a
  // community switch, so a lazy initializer would carry one community's
  // dismissal — and one account's — into the next, suppressing its alert.
  const [dismissed, setDismissed] = useState<Dismissal>(() =>
    me && idHex ? readDismissal(me, idHex) : NO_DISMISSAL,
  );

  // The watermarks live in KV behind a synchronous cache, so a mount during
  // boot reads "never dismissed". Re-read once the cache warms, and only adopt
  // a stored value that is AHEAD — a dismissal the user made while the warm was
  // in flight must not be rolled back by it.
  useEffect(() => {
    if (!me || !idHex) return;
    let cancelled = false;
    void dismissals.ready().then(() => {
      if (cancelled) return;
      const stored = readDismissal(me, idHex);
      setDismissed((prev) =>
        stored.at > prev.at || stored.unreadable > prev.unreadable ? stored : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [me, idHex]);
  // State, not a ref: React may start a render and throw it away, and a ref
  // mutation survives that while the setState does not — which would skip the
  // re-read and leave the previous community's watermark in place.
  const watermarkKey = `${me}:${idHex}`;
  const [lastKey, setLastKey] = useState(watermarkKey);
  if (lastKey !== watermarkKey) {
    setLastKey(watermarkKey);
    setDismissed(me && idHex ? readDismissal(me, idHex) : NO_DISMISSAL);
  }

  const canAct = Boolean(
    folded && me && isAuthorized(folded.roster, me, folded.ownerHex, Permissions.BAN),
  );

  // The verdicts live in module state a sweep mutates seconds after mount, and
  // on a warm launch nothing else in the dep list ever changes again.
  const verdicts = useSyncExternalStore(subscribeSweepVerdicts, sweepVerdictRevision);

  const { actors, unreadable, flooded } = useMemo<{
    actors: SuspiciousActor[];
    unreadable: number;
    flooded: boolean;
  }>(() => {
    const none = { actors: [], unreadable: 0, flooded: false };
    if (!community || !folded || !control.data || !canAct) return none;
    void verdicts;
    // Nothing to report until a sweep has actually run.
    if (!controlSweepAnswered(community)) return none;
    // A read cut short by our own budget IS the alarm, not a reason to
    // suppress it. Fifteen thousand events in one community's control history
    // is not a busy community, it is someone inflating it — and gating the
    // whole watchdog on a clean read handed the attacker a mute button for the
    // very alert that describes them.
    const short = controlSweepTruncated(community);
    // Naming someone is the one thing a short read forbids: under it we cannot
    // tell "roleless" from "we haven't reached their grant yet", and this
    // alert is one click from banning them. Same reason for the quorum — a
    // grant published to one relay and read by a client that reached another
    // makes an honest admin look like an intruder.
    const nameable = !short && controlSweepQuorum(community);
    const since = Math.max(dismissed.at, Math.floor(Date.now() / 1000) - WINDOW_SECONDS);
    return {
      flooded: short,
      actors: nameable
        ? suspiciousActivity(openControlEditions(control.data), folded, community.id, {
            since,
            opened: control.data,
          })
        : [],
      // Strictly the wraps that would NOT open: the wrap's author is the shared
      // plane key and the real signer is sealed inside, so these name nobody
      // and belong in an anonymous tally. Junk that DID open has an author and
      // is counted on that author's row instead (as unrecognised events), so
      // adding it here as well would charge one flood twice.
      unreadable: controlSweepUnreadable(community),
    };
  }, [community, folded, control.data, canAct, dismissed.at, verdicts]);

  // Ratchet the junk watermark DOWN when the flood recedes. `unreadable` is a
  // per-sweep tally, not a running total, so a dismissal taken at 500 would
  // otherwise sit above every later flood forever — one dismissal silencing the
  // signal permanently.
  useEffect(() => {
    if (unreadable >= dismissed.unreadable && (flooded || !dismissed.flooded)) return;
    const next = { ...dismissed, unreadable: Math.min(unreadable, dismissed.unreadable), flooded };
    writeDismissal(me, idHex, next);
    setDismissed(next);
  }, [unreadable, flooded, dismissed, me, idHex]);

  const dismiss = useCallback(() => {
    const next: Dismissal = { at: Math.floor(Date.now() / 1000), unreadable, flooded };
    writeDismissal(me, idHex, next);
    setDismissed(next);
  }, [me, idHex, unreadable, flooded]);

  // Junk alone raises the alarm: a pure-garbage flood names nobody, so waiting
  // for an attributable actor would miss the cheapest attack entirely. It has
  // to clear the dismissed level again, not just the threshold, or a standing
  // flood makes the banner permanent and the admin learns to ignore it.
  const alert =
    actors.length > 0 ||
    unreadable - dismissed.unreadable >= UNREADABLE_ALERT_THRESHOLD ||
    (flooded && !dismissed.flooded);

  return { actors, unreadable, flooded, alert, dismiss, canAct };
}
