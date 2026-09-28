import { useEffect, useRef, useState } from "react";

/** One throwaway context, so a browser without WebGL gives up the sea's space early. */
function canWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Only the small host is eager; without WebGL it renders nothing. */
export function SailingSea() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [supported, setSupported] = useState(() => typeof WebGLRenderingContext !== "undefined");

  useEffect(() => {
    if (!supported) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => {
      if (!canWebGL()) setSupported(false);
    });
    return () => cancel(id);
  }, [supported]);

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
        if (disposed) return;
        const teardown = mountSailingScene(host);
        if (teardown) cleanup = teardown;
        else setSupported(false);
      }).catch(() => {
        // Allow retrying a transient chunk failure.
        loading = false;
      });
    }, { rootMargin: "350px" });
    observer.observe(host);
    return () => {
      disposed = true;
      observer.disconnect();
      cleanup?.();
    };
  }, [supported]);

  if (!supported) return null;

  return (
    <div
      ref={hostRef}
      className="relative h-[85svh] min-h-[420px] w-full overflow-hidden"
      data-sailing-sea=""
    />
  );
}
