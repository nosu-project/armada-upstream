import { useEffect, useState } from "react";

/**
 * Infinite-scroll sentinel for `useInfiniteQuery`: attach the callback ref to a div at the END
 * of the grid. Viewport-rooted (`root: null`), which works for Discover's inner scroll column.
 * Fetches only on a rising edge of "in view AND idle AND has more", so no runaway loop.
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
  /** Loaded page count — used to auto-fetch page 2 after page 1. */
  pageCount: number | undefined;
  enabled?: boolean;
}): (node: Element | null) => void {
  const [sentinel, setSentinel] = useState<Element | null>(null);
  const [inView, setInView] = useState(false);

  // Page 2 right after page 1, so a short first page still leaves the sentinel reachable.
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
