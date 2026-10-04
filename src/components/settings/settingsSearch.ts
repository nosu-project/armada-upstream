import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Settings search filters the RENDERED page rather than a keyword index, so
 * every label, description and sub-component's text is searchable without a
 * second copy that drifts. The page marks its structure with data attributes:
 *
 * - `data-settings-group`   a heading plus its sections
 * - `data-settings-section` one section; `data-settings-title` is its name
 * - `data-settings-body`    the element whose CHILDREN are the matchable rows
 *                           (may be the section element itself)
 *
 * Non-matching elements get `data-search-hidden`, never a React-owned prop.
 */

const HIDDEN = "data-search-hidden";
const HIGHLIGHT = "settings-search";

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function setHidden(el: Element, hidden: boolean): void {
  if (hidden) el.setAttribute(HIDDEN, "");
  else el.removeAttribute(HIDDEN);
}

function bodyOf(section: Element): Element | null {
  return section.hasAttribute("data-settings-body")
    ? section
    : section.querySelector("[data-settings-body]");
}

/**
 * Show only the rows whose text, together with their section's title, holds
 * every term. A section whose title alone holds them stays whole. Returns the
 * number of sections left visible; an empty query clears all filtering.
 */
export function applySettingsFilter(root: Element, query: string): number {
  const terms = searchTerms(query);
  let visibleSections = 0;
  for (const group of root.querySelectorAll("[data-settings-group]")) {
    let groupVisible = false;
    for (const section of group.querySelectorAll("[data-settings-section]")) {
      const title = normalize(section.getAttribute("data-settings-title") ?? "");
      const body = bodyOf(section);
      const rows = body ? Array.from(body.children) : [];
      const titleMatches = terms.every((t) => title.includes(t));
      let anyRow = false;
      for (const row of rows) {
        const text = `${title} ${normalize(row.textContent ?? "")}`;
        const match = titleMatches || terms.every((t) => text.includes(t));
        setHidden(row, !match);
        anyRow ||= match;
      }
      const sectionVisible = titleMatches || anyRow;
      setHidden(section, !sectionVisible);
      if (sectionVisible) visibleSections++;
      groupVisible ||= sectionVisible;
    }
    setHidden(group, !groupVisible);
  }
  return visibleSections;
}

/** Ranges of every term occurrence in the visible text under `root`. */
function matchRanges(root: Element, terms: string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(`[${HIDDEN}]`)) continue;
    const text = (node.nodeValue ?? "").toLowerCase();
    for (const term of terms) {
      for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + term.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/** CSS Custom Highlight API; absent in older engines, where search just filters. */
function setHighlights(ranges: Range[]): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  if (ranges.length === 0) CSS.highlights.delete(HIGHLIGHT);
  else CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
}

/**
 * Keep `root` filtered by `query`, re-applying as section bodies mount or load
 * their data. Returns the visible-section count.
 */
export function useSettingsFilter(root: RefObject<HTMLElement | null>, query: string): number {
  const [visible, setVisible] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const terms = searchTerms(query);
    const run = () => {
      setVisible(applySettingsFilter(el, query));
      setHighlights(terms.length
        ? Array.from(el.querySelectorAll("[data-settings-section]"), (s) => matchRanges(s, terms)).flat()
        : []);
    };
    run();
    if (terms.length === 0) return;
    // Our own writes are attributes, which the observer ignores, so this can't loop.
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(run);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      setHighlights([]);
    };
  }, [root, query]);
  return visible;
}
