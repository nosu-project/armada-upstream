type ChangelogCategory = 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';

interface ChangelogEntry {
  version: string;
  date: string;
  /** Pre-section summary paragraph (≤500 chars): the store and update-toast release blurb. */
  summary?: string;
  sections: {
    category: ChangelogCategory;
    items: string[];
  }[];
}

function prettify(text: string): string {
  return text
    .replace(/ -- /g, ' \u2014 ')  // space-dash-dash-space → em dash
    .replace(/(\w)--(\w)/g, '$1\u2013$2') // word--word → en dash
    .replace(/ (\S+)$/, '\u00A0$1'); // prevent orphaned last word
}

/**
 * Parse a Keep a Changelog formatted markdown string into structured data.
 * @see https://keepachangelog.com/
 */
function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentCategory: ChangelogCategory | null = null;
  let summaryLines: string[] = [];

  const flushSummary = () => {
    if (current && summaryLines.length) {
      current.summary = summaryLines.join(' ');
    }
    summaryLines = [];
  };

  for (const line of markdown.split('\n')) {
    const versionMatch = line.match(/^## \[([^\]]+)\]\s*-\s*(.+)$/);
    if (versionMatch) {
      flushSummary();
      current = { version: versionMatch[1], date: versionMatch[2].trim(), sections: [] };
      entries.push(current);
      currentCategory = null;
      continue;
    }

    const categoryMatch = line.match(/^### (.+)$/);
    if (categoryMatch && current) {
      flushSummary();
      currentCategory = categoryMatch[1].trim() as ChangelogCategory;
      current.sections.push({ category: currentCategory, items: [] });
      continue;
    }

    const itemMatch = line.match(/^- (.+)$/);
    if (itemMatch && current) {
      const section = current.sections[current.sections.length - 1];
      if (section) {
        section.items.push(prettify(itemMatch[1]));
      } else {
        // Legacy entries opened straight into bullets: treat as "Changed".
        flushSummary();
        current.sections.push({ category: 'Changed', items: [prettify(itemMatch[1])] });
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed && current && !trimmed.startsWith('#')) {
      const section = current.sections[current.sections.length - 1];
      if (section) {
        section.items.push(prettify(trimmed));
      } else {
        summaryLines.push(trimmed);
      }
    }
  }

  flushSummary();
  return entries;
}

export { parseChangelog };
export type { ChangelogEntry, ChangelogCategory };
