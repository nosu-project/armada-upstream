import { useEffect, useRef, useState } from "react";

import type { ReactNode } from "react";

/**
 * Defer mounting `children` until a placeholder of `minHeight` scrolls near the
 * viewport, then keep it mounted (latched, like MessageRow's action toolbar).
 * This is deferred mount rather than true windowing: a row that scrolls back
 * out stays mounted, so the cost is paid once per row and scrolling never
 * un-builds what the reader just looked at.
 *
 * When `active` is false it renders `children` immediately — the shape every
 * caller wants for a short list (already cheap; gating would only add a
 * first-frame placeholder swap) and for a list being searched, where rows hide
 * themselves on a miss and a placeholder would reserve height for a row that
 * renders nothing.
 *
 * `minHeight` is the caller's row geometry in px. It only has to be close: the
 * observer fires a screenful early, so a row that grows when it mounts does so
 * below the fold.
 */
export function DeferredRow({
  active,
  minHeight,
  children,
}: {
  active: boolean;
  minHeight: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(!active);

  useEffect(() => {
    if (!active) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      // Preload a screenful ahead so rows are mounted before they're scrolled to.
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  if (shown) return <>{children}</>;
  return <div ref={ref} aria-hidden style={{ height: minHeight }} />;
}
