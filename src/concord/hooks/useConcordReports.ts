import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { KIND_WRAP } from "@/concord/lib/kinds";
import { reportInboxSecret, unwrapReport, type UnwrappedReport } from "@/concord/lib/report";
import { queryRumorsByIds } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";
import { KIND_REPORT } from "@/lib/report";

import type { NostrEvent } from "@nostrify/nostrify";

/** How many wraps one queue read pulls per relay. */
const SCAN_LIMIT = 200;

/** A report, plus the reported message's text when this moderator holds it. */
export interface ReportEntry extends UnwrappedReport {
  /**
   * The reported message's content, resolved from this member's own store.
   * Absent when the id names a channel they don't hold or history they haven't
   * synced — which is ordinary, and not a reason to hide the report.
   */
  messageText?: string;
}

/**
 * A community's report queue, for staff.
 *
 * Reports are person-addressed giftwraps at `control_pk`, not stream traffic,
 * so this reads them live from the community's relays rather than out of the
 * rumor store: they are a moderator's working list, not history the timeline
 * depends on, and nothing else needs them on disk. The indexed
 * `{ kinds: [1059], "#p": [control_pk], "#k": ["1984"] }` lookup is the same
 * shape the direct-invite inbox uses.
 *
 * Holding the Control Plane secret IS the permission — there is no separate
 * bit — so the query simply doesn't run for anyone who can't decrypt, and a
 * legacy epoch (no `control_pk`) has no queue at all.
 */
export function useConcordReports(community: Community | undefined) {
  const { nostr } = useNostr();
  const secret = community ? reportInboxSecret(community) : undefined;
  const controlPk = community?.controlPk;

  return useQuery<ReportEntry[]>({
    // The epoch's address is part of the identity: a rotation moves the queue.
    queryKey: ["concord", "reports", community?.idHex, controlPk],
    enabled: Boolean(community && controlPk && secret),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const perRelay = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query(
              [{ kinds: [KIND_WRAP], "#p": [controlPk!], "#k": [String(KIND_REPORT)], limit: SCAN_LIMIT }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
            )
            .catch(() => [] as NostrEvent[]),
        ),
      );

      const seen = new Set<string>();
      const reports: UnwrappedReport[] = [];
      for (const wrap of perRelay.flat()) {
        if (seen.has(wrap.id)) continue;
        seen.add(wrap.id);
        // The outer `k` tag was a relay-visible hint; what makes this a report
        // is that it opens under the plane secret into a kind-1984 rumor.
        const report = unwrapReport(wrap, secret!);
        if (report) reports.push(report);
      }
      reports.sort((a, b) => b.rumor.created_at - a.rumor.created_at);

      // Resolve the reported messages in ONE indexed read, so a queue of 50
      // reports isn't 50 store round-trips.
      const ids = [
        ...new Set(
          reports
            .map((r) => r.rumor.tags.find(([name]) => name === "e")?.[1])
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const byId = new Map(
        (await queryRumorsByIds(community!.idHex, ids, { signal })).map((ev) => [ev.rumorId, ev.content]),
      );

      return reports.map((r) => {
        const eventId = r.rumor.tags.find(([name]) => name === "e")?.[1];
        const messageText = eventId ? byId.get(eventId) : undefined;
        return messageText === undefined ? r : { ...r, messageText };
      });
    },
  });
}
