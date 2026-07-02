/**
 * CORD stream NIP-42 registration — keeps the relay-auth registry
 * (`lib/cord/relayAuth.ts`) loaded with every stream key the client may read
 * with, across ALL CORD communities in the membership list.
 *
 * Registered per community (against the same relay fan-out the read path
 * uses): the control-plane group keys and every channel's group keys, across
 * all retained epochs (current root + priors, private-channel epoch history).
 * Registration is idempotent; on a NIP-42 challenge the pool AUTHs as each
 * key, which is what lets DM-protecting relays serve our `authors`-filtered
 * kind-1059 REQs ("AUTH as the room"). Rekey-probe addresses are registered
 * at query time by the rekey hook (they're ephemeral, epoch+1 probes).
 */

import { useEffect } from "react";

import { useConcordList } from "@/hooks/useConcordList";
import { CORD_TRUSTED_RELAYS } from "@/lib/concord/publicInvite";
import { capRelays } from "@/lib/concord/types";
import { acceptCordInvite, cordChannelGroups, isCordInvite } from "@/lib/cord/community";
import { cordControlGroups } from "@/lib/cord/control";
import { registerCordStreamKeys, type StreamAuthKey } from "@/lib/cord/relayAuth";

export function CordStreamAuth(): null {
  const { data } = useConcordList();

  useEffect(() => {
    if (!data) return;
    for (const entry of data.list.entries) {
      const bundle = entry.current.keys.cord;
      if (!isCordInvite(bundle)) continue;
      try {
        const community = acceptCordInvite(bundle);
        const groups: StreamAuthKey[] = [
          ...cordControlGroups(community).map((eg) => eg.group),
          ...community.channels.flatMap((ch) => cordChannelGroups(community, ch).map((eg) => eg.group)),
        ];
        // Same union as useConcordCommunity's runtime fan-out.
        registerCordStreamKeys(capRelays([...community.relays, ...CORD_TRUSTED_RELAYS]), groups);
      } catch {
        // Malformed bundle — the list layer surfaces it; nothing to auth.
      }
    }
  }, [data]);

  return null;
}
