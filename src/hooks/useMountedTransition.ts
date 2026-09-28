import { useEffect, useState } from "react";

/**
 * Keeps a panel mounted through its exit animation. `mounted`: in the DOM (true for `exitMs`
 * after close). `visible`: the animation target, flipped true a frame after mount.
 */
export function useMountedTransition(open: boolean, exitMs = 200) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setVisible(false);
    if (!mounted) return;
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, mounted, exitMs]);

  // Flip on the next paint so the enter transition runs from the collapsed state.
  useEffect(() => {
    if (!mounted || !open) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [mounted, open]);

  return { mounted, visible };
}
