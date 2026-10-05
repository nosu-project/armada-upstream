import { ChevronDown, Shield } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { useIsTouch } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";

import type { MemberActionItem } from "@/contexts/MemberActionsContext";

export interface ModerationMenuParts {
  Item: ComponentType<{ className?: string; disabled?: boolean; onSelect?: (e: Event) => void; children?: ReactNode }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
}

/**
 * Hide/block/report/delete/kick/ban, one deliberate step away from the everyday
 * items so a slip can't land on them: a submenu with a pointer, an inline
 * expander on touch (a side-opening submenu has no room on a phone).
 */
export function ModerationMenuSection({
  parts: { Item, Sub, SubTrigger, SubContent },
  label = "Moderation",
  children,
}: {
  parts: ModerationMenuParts;
  label?: string;
  children: ReactNode;
}) {
  const isTouch = useIsTouch();
  const [open, setOpen] = useState(false);

  if (!isTouch) {
    return (
      <Sub>
        <SubTrigger>
          <Shield className="size-4" />
          {label}
        </SubTrigger>
        <SubContent className="w-56">{children}</SubContent>
      </Sub>
    );
  }

  return (
    <>
      <Item
        onSelect={(e) => {
          // Expanding is not a choice: keep the menu open.
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <Shield className="size-4" />
        {label}
        <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </Item>
      {open && <div className="ml-3 border-l border-foreground/10 pl-1">{children}</div>}
    </>
  );
}

/** A person's {@link useUserModeration} actions, as one moderation section of a Radix menu. */
export function UserModerationMenuSection({
  parts,
  actions,
  onBeforeSelect,
}: {
  parts: ModerationMenuParts;
  actions: MemberActionItem[];
  /** E.g. close a surrounding popover that the action would unmount. */
  onBeforeSelect?: () => void;
}) {
  if (actions.length === 0) return null;
  const { Item } = parts;
  return (
    <ModerationMenuSection parts={parts}>
      {actions.map((action) => (
        <Item
          key={action.id}
          disabled={action.disabled}
          className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
          onSelect={() => {
            onBeforeSelect?.();
            action.onSelect();
          }}
        >
          <action.icon className="size-4" />
          {action.label}
        </Item>
      ))}
    </ModerationMenuSection>
  );
}
