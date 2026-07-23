import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import {
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
      const announcements = await store.query([{ kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], "#d": [...new Set([...attachmentsByChannel.values()].flatMap((items) => items.map((item) => item.address.identifier)))], limit: 1_000 }]);
      const repos = announcements.map(parseGitRepositoryAnnouncement).filter((repo): repo is NonNullable<typeof repo> => Boolean(repo));
      return new Map([...attachmentsByChannel].map(([id, attachments]) => [id, buildGitTimelineActivities([...roots, ...children], attachments, repos)]));
    },
  });
  useWireScopes((scopes) => {
    if (addresses.some((address) => scopes.has(`git:${address}`))) void query.refetch();
  });
  return { byChannel: query.data ?? new Map() };
}
