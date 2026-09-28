import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { MessageActionItem } from "@/components/chat/messageActions";

/** The desktop toolbar's `⋯`: everything not worth a dedicated button. */
export function MessageOverflowMenu({ actions }: { actions: MessageActionItem[] }) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="More actions"
              className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
            >
              <MoreHorizontal className="size-[18px] md:size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        {actions.map((action) => (
          <div key={action.id}>
            {action.groupStart && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
              onSelect={action.onSelect}
            >
              <action.icon className="mr-2 size-4" />
              {action.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
