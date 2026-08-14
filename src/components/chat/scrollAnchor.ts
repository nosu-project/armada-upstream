/**
 * Pixel-stable anchoring for normal-flow chat scrollers.
 *
 * WebKit does not implement CSS scroll anchoring, while message rows routinely
 * change height after mount (images, embeds, reactions). These helpers keep a
 * short run of DOM rows and their viewport offsets, then compensate by the
 * measured delta after React or asynchronous content changes the layout.
 */

/** Attribute placed on stable normal-flow rows that can anchor a viewport. */
export const SCROLL_ANCHOR_ATTR = "data-scroll-anchor";

/** Enough survivors to tolerate an expired/filtered/re-keyed leading row. */
const FALLBACK_ROWS = 4;

interface ScrollAnchorRow {
  /** The live element makes the common restore O(1), even in a long history. */
  element: HTMLElement;
  key: string;
  /** Row top relative to the scroller's visible top edge. */
  offset: number;
}

/** A leading row plus a few following fallbacks in case that row disappears. */
export interface ScrollAnchor {
  rows: ScrollAnchorRow[];
}

/** Safari rubber-band scrolling can expose offsets outside the real range. */
export function clampedScrollTop(scroller: HTMLElement): number {
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return Math.min(max, Math.max(0, scroller.scrollTop));
}

/** Non-negative distance from the newest edge, normalized through bounce. */
export function distanceFromBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - clampedScrollTop(scroller) - scroller.clientHeight);
}

function isAnchorRow(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.hasAttribute(SCROLL_ANCHOR_ATTR);
}

function nextAnchorRow(element: Element | null): HTMLElement | null {
  let next = element?.nextElementSibling ?? null;
  while (next && !isAnchorRow(next)) next = next.nextElementSibling;
  return next;
}

function previousAnchorRow(element: Element | null): HTMLElement | null {
  let previous = element?.previousElementSibling ?? null;
  while (previous && !isAnchorRow(previous)) previous = previous.previousElementSibling;
  return previous;
}

function rowOffset(scroller: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * Find the first stable row touching/following the viewport.
 *
 * Once an anchor exists this walks only neighbouring rows, so a momentum-scroll
 * event does not query and scan hundreds of already-rendered messages. The one
 * cold capture uses a selector; subsequent captures and every normal restore
 * retain direct DOM references.
 */
export function captureScrollAnchor(
  scroller: HTMLElement,
  content: HTMLElement,
  previous?: ScrollAnchor | null,
): ScrollAnchor | null {
  const scrollerTop = scroller.getBoundingClientRect().top;
  let row = previous?.rows.find(({ element, key }) =>
    content.contains(element) && element.getAttribute(SCROLL_ANCHOR_ATTR) === key,
  )?.element ?? null;

  if (row) {
    // Walk toward the current viewport from the last known row. Ordinary
    // scroll events move by only a neighbour or two; a scrollbar drag still
    // remains bounded by the rendered window rather than doing a selector plus
    // a second scan.
    while (row.getBoundingClientRect().bottom <= scrollerTop) {
      const next = nextAnchorRow(row);
      if (!next) return null;
      row = next;
    }
    for (;;) {
      const previousRow = previousAnchorRow(row);
      if (!previousRow || previousRow.getBoundingClientRect().bottom <= scrollerTop) break;
      row = previousRow;
    }
  } else {
    const rows = content.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTR}]`);
    row = [...rows].find((candidate) => candidate.getBoundingClientRect().bottom > scrollerTop) ?? null;
  }

  if (!row) return null;
  const rows: ScrollAnchorRow[] = [];
  while (row && rows.length < FALLBACK_ROWS) {
    rows.push({
      element: row,
      key: row.getAttribute(SCROLL_ANCHOR_ATTR) ?? "",
      offset: rowOffset(scroller, row),
    });
    row = nextAnchorRow(row);
  }
  return { rows };
}

/**
 * Restore the first captured row that survived to the same viewport pixel.
 * Returns false only when every captured row is gone. Sub-pixel/no movement is
 * deliberately a no-op: needless `scrollTop` writes cancel iOS momentum.
 */
export function restoreScrollAnchor(
  scroller: HTMLElement,
  content: HTMLElement,
  anchor: ScrollAnchor,
): boolean {
  for (const captured of anchor.rows) {
    const { element, key, offset } = captured;
    if (!content.contains(element) || element.getAttribute(SCROLL_ANCHOR_ATTR) !== key) continue;
    const delta = rowOffset(scroller, element) - offset;
    if (Math.abs(delta) >= 0.5) scroller.scrollTop = clampedScrollTop(scroller) + delta;
    return true;
  }
  return false;
}
