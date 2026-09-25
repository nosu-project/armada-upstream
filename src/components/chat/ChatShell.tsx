import { useRef, type ComponentProps, type ReactNode } from "react";

import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import type { AppScope } from "@/contexts/AppsContext";

/**
 * The frame every chat surface shares: the mobile drill-down (`SwipeReveal`
 * with the rail and the surface's own left list underneath), the main column,
 * and the coordination scope for in-message app launches. A community and a
 * DM are the same surface in two shapes; this is the shape, and everything
 * that differs between them renders as `children`.
 */
export function ChatShell({
  reveal,
  scope,
  children,
}: {
  reveal: Pick<ComponentProps<typeof SwipeReveal>, "open" | "onReveal" | "onClose" | "underlay">;
  /** `ChatScopeContext` for the open room; undefined when nothing is open. */
  scope: AppScope | undefined;
  children: ReactNode;
}) {
  // Callers build `scope` inline, and a context value that changes identity
  // re-renders every consumer — every message row reads it — so hold one
  // object per distinct scope.
  const held = useRef(scope);
  if (!sameScope(held.current, scope)) held.current = scope;
  const stableScope = held.current;
  return (
    <SwipeReveal {...reveal}>
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        <ChatScopeContext.Provider value={stableScope}>{children}</ChatScopeContext.Provider>
      </main>
    </SwipeReveal>
  );
}

/**
 * Two scopes naming the same room. A Concord scope compares its community and
 * channel by IDENTITY rather than id, so a changed community (new metadata, a
 * rekey) still reaches the consumers.
 */
function sameScope(a: AppScope | undefined, b: AppScope | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (b.kind) {
    case "nip29": {
      const x = a as typeof b;
      return x.relayUrl === b.relayUrl && x.groupId === b.groupId;
    }
    case "concord": {
      const x = a as typeof b;
      return x.community === b.community && x.channel === b.channel;
    }
    case "dm":
      return (a as typeof b).conversation === b.conversation;
  }
}
