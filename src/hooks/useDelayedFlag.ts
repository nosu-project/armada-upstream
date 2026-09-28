import { useEffect, useState } from "react";

/**
 * `true` only once `active` has stayed `true` for `delay` ms; `false` immediately
 * otherwise. Gates skeletons so fast loads never flash one.
 */
export function useDelayedFlag(active: boolean, delay = 200): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);

  return shown;
}
