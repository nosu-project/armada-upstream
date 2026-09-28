import { useState, type ReactNode } from "react";

/**
 * Renders `children` once `open` has ever been true. A closed Radix dialog
 * still runs its hooks on every page render; latched so close animations play.
 */
export function MountWhenOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened ? children : null;
}
