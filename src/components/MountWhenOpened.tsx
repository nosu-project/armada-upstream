import { useState, type ReactNode } from "react";

/**
 * Renders `children` from the first time `open` is true onward — for a dialog
 * a page keeps in its tree but rarely opens. A closed Radix dialog still runs
 * its own component and every hook in it (queries included) on each render of
 * the page that holds it, and a page like a community's re-renders on every
 * switch and every incoming message. Latched rather than tied to `open`, so a
 * close still plays its exit animation.
 */
export function MountWhenOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened ? children : null;
}
