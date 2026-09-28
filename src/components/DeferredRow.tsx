import { useEffect, useRef, useState } from "react";

import type { ReactNode } from "react";

/**
 * Defer mounting `children` until the `minHeight` placeholder nears the
 * viewport, then keep it mounted (not windowing). When `active` is false,
 * renders immediately (short lists, or searched lists whose rows may render nothing).
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
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  if (shown) return <>{children}</>;
  return <div ref={ref} aria-hidden style={{ height: minHeight }} />;
}
