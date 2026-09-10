import { Search, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The inline message-search bar in every chat header. It slides in from the
 * right over the title and actions (a GPU-composited transform, so no
 * per-frame reflow) and focuses its input on open with `preventScroll`: the
 * input starts off-screen, so a plain `focus()` would jolt the page to reveal
 * it. The caller owns the state, since Concord's query is one field of a
 * `SearchFilters` struct and the others' is a bare string.
 */
export function ChatSearchBar({
  open,
  value,
  onChange,
  onClose,
  placeholder,
  filters,
}: {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  placeholder: string;
  /** Rendered between the input and the close button (Concord's filters popover). */
  filters?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 left-10 sidebar:left-0 z-10 flex items-center gap-1.5 px-2 sidebar:px-3",
        "bg-chrome clip-corner-lg overflow-hidden",
        "transition-transform duration-300 ease-in-out",
        open ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none",
      )}
    >
      <Search className="size-4 text-muted-foreground shrink-0" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder={placeholder}
        aria-label="Search messages"
        className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      {filters}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close search"
        className="size-8 touch:size-10 shrink-0 text-muted-foreground"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
