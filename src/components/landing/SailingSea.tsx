import { useEffect, useRef, useState } from "react";

/**
 * Whether this browser can open a WebGL context at all. One throwaway context,
 * released straight away, so a browser without WebGL gives up the sea's space
 * before anyone scrolls to it rather than as they arrive.
 */
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

/** Only the small host is eager. Neither Three nor a GL context is needed by
 * the first screen. Without WebGL the host renders nothing and takes no space. */
export function SailingSea() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [supported, setSupported] = useState(() => typeof WebGLRenderingContext !== "undefined");

  // The probe runs off the first paint, once the landing has settled.
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
