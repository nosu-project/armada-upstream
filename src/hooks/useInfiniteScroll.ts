import { useEffect, useState } from "react";

/**
 * Infinite-scroll sentinel for a react-query `useInfiniteQuery` list.
 *
 * Returns a callback ref to attach to a small `<div>` placed at the END of the
 * grid: when that sentinel comes within a screenful of the viewport,
 * `fetchNextPage` is called. Also fetches page 2 as soon as page 1 lands, so a
 * short first page that doesn't fill the viewport still becomes scrollable.
 *
 * Viewport-rooted (`root: null`) like {@link DeferredRow} and
 * `useSeenOnScreen`: Discover scrolls in an inner `overflow-y-auto` column, and
 * those observers already fire correctly against it, so a large `rootMargin` is
 * enough and there is no scroll-container ref to thread through.
 *
 * A guard against a runaway loop: the observer stays connected while
 * `isFetchingNextPage`, but the fetch is only issued on a rising edge of "in
 * view AND idle AND has more", so a page that lands still inside the margin
 * fetches the next one exactly once, not on every observer callback.
 */
export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  pageCount,
  enabled = true,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /** How many pages are loaded — used to auto-fetch page 2 after page 1. */
  pageCount: number | undefined;
  /** Disabled while the tab is inactive / searching, or has nothing to page. */
  enabled?: boolean;
}): (node: Element | null) => void {
  const [sentinel, setSentinel] = useState<Element | null>(null);
  const [inView, setInView] = useState(false);

  // Auto-fetch page 2 the moment page 1 arrives, so a first page shorter than
  // the viewport still leaves the sentinel reachable.
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && pageCount === 1) {
      fetchNextPage();
    }
  }, [enabled, hasNextPage, isFetchingNextPage, pageCount, fetchNextPage]);

  useEffect(() => {
    if (!enabled || !sentinel || typeof IntersectionObserver === "undefined") {
      setInView(false);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setInView(entries[entries.length - 1]?.isIntersecting ?? false),
      // A screenful of lead time, so the next page is usually in hand before
      // the reader reaches the bottom.
      { rootMargin: "600px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [enabled, sentinel]);

  useEffect(() => {
    if (inView && enabled && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [inView, enabled, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return setSentinel;
}
