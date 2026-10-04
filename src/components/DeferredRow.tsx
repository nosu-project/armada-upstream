import { useEffect, useRef, useState } from "react";

import type { ReactNode, RefObject } from "react";

/**
 * Defer mounting `children` until the `minHeight` placeholder nears the
 * viewport, then keep it mounted (not windowing). When `active` is false,
 * renders immediately (short lists, or searched lists whose rows may render nothing).
 *
 * `rootRef` observes against a scroll container instead of the viewport, so a list
 * parked off-screen (transformed out, clipped) still builds its first screenful.
 */
export function DeferredRow({
  active,
  minHeight,
  rootRef,
  children,
}: {
  active: boolean;
  minHeight: number;
  rootRef?: RefObject<Element | null>;
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
      { root: rootRef?.current ?? null, rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active, rootRef]);

  if (shown) return <>{children}</>;
  return <div ref={ref} aria-hidden style={{ height: minHeight }} />;
}
