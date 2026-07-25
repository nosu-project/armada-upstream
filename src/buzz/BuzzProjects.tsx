import { ProjectsView } from "@/components/projects/ProjectsView";

import { useBuzzRepos, useBuzzWorkItems } from "@/buzz/useBuzzProjects";

/**
 * A Buzz workspace's Projects view — the shared Projects surface (tabbed
 * Overview / Repositories / Pull Requests / Issues, stat pills, contribution
 * graph, people roster, activity feed) driven by the relay's NIP-34 events
 * (repos 30617, issues 1621, patches 1617, PRs 1618, statuses 1630–1633).
 */
export function BuzzProjectsView({ relayUrl }: { relayUrl: string }) {
  const { data: repos, isLoading: reposLoading } = useBuzzRepos(relayUrl);
  const { data: workItems, isLoading: itemsLoading } = useBuzzWorkItems(relayUrl);

  return (
    <ProjectsView
      repos={repos ?? []}
      items={workItems ?? []}
      isLoading={reposLoading || itemsLoading}
    />
  );
}
