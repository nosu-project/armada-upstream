import { useRef, type ComponentProps, type ReactNode } from "react";

import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { CustomEmojisProvider } from "@/hooks/useCustomEmojis";
import type { AppScope } from "@/contexts/AppsContext";

/**
 * The frame every chat surface shares: mobile drill-down (`SwipeReveal`), main
 * column and app-launch scope. Differences render as `children`.
 */
export function ChatShell({
  reveal,
  scope,
  children,
}: {
  reveal: Pick<ComponentProps<typeof SwipeReveal>, "open" | "onReveal" | "onClose" | "canClose" | "underlay">;
  /** `ChatScopeContext` for the open room; undefined when nothing is open. */
  scope: AppScope | undefined;
  children: ReactNode;
}) {
  // Callers build `scope` inline; hold one object per distinct scope so every
  // consumer (each message row) doesn't re-render.
  const held = useRef(scope);
  if (!sameScope(held.current, scope)) held.current = scope;
  const stableScope = held.current;
  return (
    <SwipeReveal {...reveal}>
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        <ChatScopeContext.Provider value={stableScope}>
          <CustomEmojisProvider>{children}</CustomEmojisProvider>
        </ChatScopeContext.Provider>
      </main>
    </SwipeReveal>
  );
}

/** Concord compares community/channel by IDENTITY, so metadata changes or rekeys propagate. */
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
