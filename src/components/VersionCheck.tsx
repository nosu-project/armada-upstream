import { useEffect } from "react";
import { Link } from "react-router-dom";

import { toast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import { parseChangelog } from "@/lib/changelog";
import { getStorageKey } from "@/lib/storageKey";

const EXCERPT_MAX_LENGTH = 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  // Only break on a word boundary if it isn't comically early.
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace).trimEnd() : slice;
  return cut + "…";
}

/** Release blurb: section summary, else the first bullet. */
async function fetchChangelogExcerpt(version: string): Promise<string | undefined> {
  try {
    const res = await fetch("/CHANGELOG.md");
    if (!res.ok) return undefined;
    const markdown = await res.text();
    const entries = parseChangelog(markdown);

    const entry = entries.find((e) => e.version === version) ?? entries[0];
    if (!entry) return undefined;

    if (entry.summary) return truncate(entry.summary, EXCERPT_MAX_LENGTH);

    const item = entry.sections[0]?.items[0];
    if (!item) return undefined;
    return truncate(item, EXCERPT_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

/** "What's new" toast on version change. Inside <BrowserRouter> so "See all" resolves. */
export function VersionCheck() {
  useEffect(() => {
    const currentVersion = import.meta.env.VERSION;
    if (!currentVersion) return;

    const storageKey = getStorageKey("armada", "app-version");
    const storedVersion = localStorage.getItem(storageKey);
    localStorage.setItem(storageKey, currentVersion);

    if (storedVersion && storedVersion !== currentVersion) {
      const { update, id } = toast({
        title: `What's new in v${currentVersion}`,
        action: (
          <ToastAction altText="View changelog" asChild>
            <Link to="/changelog">See all</Link>
          </ToastAction>
        ),
      });

      fetchChangelogExcerpt(currentVersion).then((excerpt) => {
        if (excerpt) {
          update({
            id,
            title: `What's new in v${currentVersion}`,
            description: excerpt,
            action: (
              <ToastAction altText="View changelog" asChild>
                <Link to="/changelog">See all</Link>
              </ToastAction>
            ),
          });
        }
      });
    }
  }, []);

  return null;
}
