import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** A rendered provider frame posts to us within this long of its `load`. */
const AFTER_LOAD_MS = 5_000;
/** Upper bound once on screen, for a blocked frame whose `load` never fires. */
const AFTER_VISIBLE_MS = 15_000;

/**
 * Whether a provider iframe actually rendered. A frame blocked by tracking
 * protection (LibreWolf, Firefox strict, uBlock) or an error page never
 * posts its resize/measure message, and nothing else is observable across
 * origins — so silence past a grace period is the failure signal.
 */
export function useEmbedLiveness(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [failed, setFailed] = useState(false);
  const aliveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const arm = useCallback((ms: number) => {
    if (aliveRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!aliveRef.current) setFailed(true);
    }, ms);
  }, []);

  const markAlive = useCallback(() => {
    aliveRef.current = true;
    clearTimeout(timerRef.current);
  }, []);

  const onLoad = useCallback(() => arm(AFTER_LOAD_MS), [arm]);

  useEffect(() => {
    const iframe = iframeRef.current;
    // Off-screen lazy frames haven't been requested yet; don't time them out.
    if (!iframe || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        if (timerRef.current === undefined) arm(AFTER_VISIBLE_MS);
      }
    });
    observer.observe(iframe);
    return () => observer.disconnect();
  }, [iframeRef, arm]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { failed, markAlive, onLoad };
}
