import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePortalDropdown } from "@/hooks/usePortalDropdown";
import { matchSlashCommands, type SlashCommand } from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

interface SlashCommandAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  canModerate: boolean;
  /** Replace the command word `/query` with `/<name> ` (keeps the menu intent). */
  onInsertCommand: (params: { start: number; end: number; replacement: string }) => void;
  /** Run a command immediately (for argument-less commands picked from the menu). */
  onRunCommand: (command: SlashCommand) => void;
}

/**
 * Detects a leading `/command` at the very start of an empty-ish composer and
 * shows a command palette. Only triggers when the message begins with `/` and
 * the first token (the command word) is still being typed — so it never
 * interferes with URLs, file paths, or mid-message slashes.
 */
export function SlashCommandAutocomplete({
  textareaRef,
  content,
  canModerate,
  onInsertCommand,
  onRunCommand,
}: SlashCommandAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  // Bottom-anchored so the menu hugs the top of the composer and grows upward;
  // a short list sits right against the composer instead of floating with a gap.
  const [dropdownPos, setDropdownPos] = useState<{ bottom: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);
  const { renderPortal } = usePortalDropdown({
    textareaRef,
    isOpen,
    onClose: handleClose,
    dropdownHeight: 260,
  });

  const matches = useMemo(
    () => (isOpen ? matchSlashCommands(query, canModerate) : []),
    [isOpen, query, canModerate],
  );

  const detect = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const value = textarea.value;

    // Only when the whole message is a command word being typed: starts with
    // "/" and no whitespace yet (once a space is typed we're entering args).
    const match = value.match(/^\/(\w*)$/);
    if (!match) {
      setIsOpen(false);
      return;
    }

    setQuery(match[1]);
    setSelectedIndex(0);
    setIsOpen(true);

    // Anchor the menu's bottom just above the composer's top edge.
    const rect = textarea.getBoundingClientRect();
    setDropdownPos({
      bottom: window.innerHeight - rect.top + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8)),
    });
  }, [textareaRef]);

  useEffect(() => {
    detect();
  }, [content, detect]);

  const selectCommand = useCallback((command: SlashCommand) => {
    setIsOpen(false);
    // Argument-less commands run immediately on pick; others insert "/name "
    // so the user can type the target/text next.
    if (command.runsOnSelect) {
      onRunCommand(command);
      return;
    }
    const textarea = textareaRef.current;
    const end = textarea?.value.length ?? query.length + 1;
    onInsertCommand({ start: 0, end, replacement: `/${command.name} ` });
  }, [textareaRef, query, onInsertCommand, onRunCommand]);

  useEffect(() => {
    if (!isOpen || matches.length === 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev < matches.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          e.stopImmediatePropagation();
          selectCommand(matches[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };

    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, matches, selectedIndex, textareaRef, selectCommand]);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-slash-item]");
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !dropdownPos || matches.length === 0) return null;

  const dropdown = (
    <div
      data-autocomplete-dropdown
      className="fixed z-[300] w-[320px] rounded-xl border border-border bg-popover shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150 pointer-events-auto"
      style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
    >
      <div ref={listRef} className="max-h-[260px] overflow-y-auto py-1">
        {matches.map((command, index) => (
          <button
            key={command.name}
            data-slash-item
            className={cn(
              "w-full flex items-baseline gap-2 px-3 py-2 text-left transition-colors cursor-pointer",
              index === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-secondary/60",
            )}
            onClick={() => selectCommand(command)}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="font-mono text-sm font-semibold shrink-0">
              {command.usage ?? `/${command.name}`}
            </span>
            <span className="text-xs text-muted-foreground truncate">{command.description}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return renderPortal(dropdown, document.body);
}
