import { useEffect, useRef } from "react";

/** Only the small host is eager. Neither Three nor a GL context is needed by
 * the first screen, and failed/unsupported WebGL leaves the existing sea visible. */
export function SailingSea() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") return;
    let disposed = false;
    let loading = false;
    let cleanup: (() => void) | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || loading) return;
      loading = true;
      void import("./sailingScene").then(({ mountSailingScene }) => {
        if (!disposed) cleanup = mountSailingScene(host);
      }).catch(() => {
        // A later approach can retry a transient chunk download failure.
        loading = false;
      });
    }, { rootMargin: "350px" });
    observer.observe(host);
    return () => {
      disposed = true;
      observer.disconnect();
      cleanup?.();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="relative h-[85svh] min-h-[420px] w-full overflow-hidden"
      data-sailing-sea=""
    />
  );
}
