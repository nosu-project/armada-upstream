import { createContext, type RefObject } from "react";

import type { Location, NavigateFunction } from "react-router-dom";

/**
 * Router location and `navigate` as stable refs, for callers that only need
 * them in handlers: `useLocation`/`useNavigate` re-render on every navigation,
 * which re-rendered every chat row. `null` outside `LocationRefProvider`.
 */
export interface RouterRefs {
  location: RefObject<Location | undefined>;
  navigate: RefObject<NavigateFunction | undefined>;
}

export const LocationRefContext = createContext<RouterRefs | null>(null);
