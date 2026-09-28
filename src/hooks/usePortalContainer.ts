import { createContext, useContext } from 'react';

/**
 * Container for Radix portals. Needed inside a Radix Dialog, whose RemoveScroll blocks
 * scrolling outside its DOM tree.
 */
const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

export const PortalContainerProvider = PortalContainerContext.Provider;

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}
