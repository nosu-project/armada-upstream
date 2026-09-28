/**
 * Pixel-stable anchoring for normal-flow chat scrollers: WebKit lacks CSS
 * scroll anchoring and rows change height after mount, so restore a captured
 * row's viewport offset by the measured delta.
 */

/** Attribute placed on stable normal-flow rows that can anchor a viewport. */
export const SCROLL_ANCHOR_ATTR = "data-scroll-anchor";

/** Enough survivors to tolerate an expired/filtered/re-keyed leading row. */
const FALLBACK_ROWS = 4;

interface ScrollAnchorRow {
  element: HTMLElement;
  key: string;
  /** Row top relative to the scroller's visible top edge. */
  offset: number;
}

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
 * First stable row touching/following the viewport. After the first (selector)
 * capture this walks only neighbouring rows.
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
    // Scroll events move a row or two, so walk from the last known row.
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
 * Restore the first surviving captured row to the same pixel; false only when
 * all are gone. Sub-pixel moves are skipped (writes cancel iOS momentum).
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
