import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import {
  EVENT_DELETION_KIND,
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  buildGitTimelineActivities,
  parseGitRepositoryAnnouncement,
  type GitRepositoryAttachment,
  type GitTimelineActivity,
} from "@/lib/gitActivity";
import { useWireScopes } from "@/wire/useWireScopes";

/** Shared, store-first Git activity scan used by every Concord V2 unread badge. */
export function useCommunityGitActivity(attachmentsByChannel: ReadonlyMap<string, readonly GitRepositoryAttachment[]>): { byChannel: Map<string, readonly GitTimelineActivity[]> } {
  const eventStore = useEventStore();
  const signature = [...attachmentsByChannel.entries()].map(([id, attachments]) => `${id}:${attachments.map((a) => `${a.address.coordinate}:${a.attachedAt}:${a.detachedAt ?? ""}`).join(",")}`).sort().join("|");
  const addresses = [...new Set([...attachmentsByChannel.values()].flatMap((items) => items.map((item) => item.address.coordinate)))];
  const query = useQuery({
    queryKey: ["git", "community-activity", signature],
    enabled: addresses.length > 0,
    queryFn: async () => {
      const store = await eventStore;
      const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, limit: 4_000 }]);
      const ids = roots.map((root) => root.id);
      const children = ids.length ? await store.query([{ kinds: [NIP22_COMMENT_KIND], "#E": ids, limit: 8_000 }, { kinds: [...GIT_STATUS_KINDS], "#e": ids, limit: 8_000 }]) : [];
      const childIds = [...new Set(children.map((child) => child.id))].sort();
      const deletions = childIds.length ? await store.query([{ kinds: [EVENT_DELETION_KIND], "#e": childIds, limit: 8_000 }]) : [];
      // Exact per-owner filters: a bare `#d` match drags in same-identifier
      // repos from unrelated authors.
      const uniqueAddresses = [...new Map([...attachmentsByChannel.values()].flatMap((items) => items.map((item) => [item.address.coordinate, item.address]))).values()];
      const announcements = uniqueAddresses.length === 0 ? [] : await store.query(uniqueAddresses.map((address) => ({
        kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], authors: [address.owner], "#d": [address.identifier], limit: 1,
      })));
      const repos = announcements.map(parseGitRepositoryAnnouncement).filter((repo): repo is NonNullable<typeof repo> => Boolean(repo));
      return new Map([...attachmentsByChannel].map(([id, attachments]) => [id, buildGitTimelineActivities([...roots, ...children, ...deletions], attachments, repos)]));
    },
  });
  useWireScopes((scopes) => {
    if (addresses.some((address) => scopes.has(`git:${address}`))) void query.refetch();
  });
  return { byChannel: query.data ?? new Map() };
}
