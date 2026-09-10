import { type ComponentProps, type ReactNode } from "react";

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
  return (
    <SwipeReveal {...reveal}>
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        <ChatScopeContext.Provider value={scope}>{children}</ChatScopeContext.Provider>
      </main>
    </SwipeReveal>
  );
}
