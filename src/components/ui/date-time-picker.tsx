import { format } from "date-fns";
import { ArrowLeft, CalendarDays, Check, Clock } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateTimeString(d: Date): string {
  return `${toDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseValue(value: string): Date | undefined {
  if (!value) return undefined;
  // `new Date("YYYY-MM-DD")` is UTC midnight, but we read local getters, so
  // build local midnight from parts (west of UTC would show the day before).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

interface DateTimePickerProps {
  mode: "date" | "datetime";
  /** `YYYY-MM-DD` (date) or `YYYY-MM-DDTHH:mm` (datetime). */
  value: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  placeholder?: string;
}

const SLOTS = Array.from({ length: 48 }, (_, i) => ({ h: Math.floor(i / 2), m: i % 2 === 0 ? 0 : 30 }));

function formatLabel(date: Date | undefined, mode: "date" | "datetime", placeholder?: string): string {
  if (!date) return placeholder ?? "Pick a date";
  return format(date, mode === "datetime" ? "EEE, MMM d, yyyy 'at' h:mm a" : "EEE, MMM d, yyyy");
}

/**
 * Date (and optional time) picker whose panel overlays the enclosing dialog;
 * the parent must be `relative`. Keeps its own draft so picking re-renders only the overlay.
 */
export function DateTimePicker({ mode, value, onChange, onOpenChange, id, placeholder }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const date = parseValue(value);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const Icon = mode === "datetime" ? Clock : CalendarDays;

  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        onClick={() => setOpenState(true)}
        className={cn("h-10 w-full justify-start gap-2 px-3 font-normal", !date && "text-muted-foreground")}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{formatLabel(date, mode, placeholder)}</span>
      </Button>

      {open && (
        <PickerOverlay
          mode={mode}
          initial={date}
          placeholder={placeholder}
          onChange={onChange}
          onClose={() => setOpenState(false)}
        />
      )}
    </>
  );
}

/** `selectedDayMs` is a primitive so time-only changes don't re-render the (expensive) calendar. */
const MemoCalendar = memo(function MemoCalendar({
  selectedDayMs,
  onSelect,
}: {
  selectedDayMs: number | undefined;
  onSelect: (d: Date | undefined) => void;
}) {
  const selected = selectedDayMs !== undefined ? new Date(selectedDayMs) : undefined;
  return <Calendar mode="single" selected={selected} onSelect={onSelect} autoFocus />;
});

function PickerOverlay({
  mode,
  initial,
  placeholder,
  onChange,
  onClose,
}: {
  mode: "date" | "datetime";
  initial: Date | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  // Pushed to the parent only on close, so picking never re-renders the heavy dialog.
  const [draft, setDraft] = useState<Date | undefined>(initial);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedH = draft?.getHours();
  const selectedM = draft?.getMinutes();
  const selectedDayMs = useMemo(
    () => (draft ? new Date(draft.getFullYear(), draft.getMonth(), draft.getDate()).getTime() : undefined),
    [draft],
  );

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commitAndClose = useCallback(() => {
    const d = draftRef.current;
    if (d) onChange(mode === "datetime" ? toDateTimeString(d) : toDateString(d));
    onClose();
  }, [mode, onChange, onClose]);

  // Functional updates keep MemoCalendar's props stable across time changes.
  const setDay = useCallback((day: Date | undefined) => {
    if (!day) return;
    if (mode === "datetime") {
      setDraft((prev) => {
        const next = new Date(day);
        if (prev) next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
        else next.setHours(9, 0, 0, 0);
        return next;
      });
    } else {
      onChange(toDateString(new Date(day)));
      onClose();
    }
  }, [mode, onChange, onClose]);

  const setTime = useCallback((h: number, m: number) => {
    setDraft((prev) => {
      const next = prev ? new Date(prev) : (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d; })();
      next.setHours(h, m, 0, 0);
      return next;
    });
  }, []);

  useEffect(() => {
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "center" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") commitAndClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitAndClose]);

  const timeList = useMemo(
    () =>
      SLOTS.map(({ h, m }) => {
        const active = h === selectedH && m === selectedM;
        const labelH = h % 12 === 0 ? 12 : h % 12;
        const mer = h < 12 ? "AM" : "PM";
        return (
          <button
            key={`${h}:${m}`}
            type="button"
            data-active={active}
            onClick={() => setTime(h, m)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              active ? "bg-primary text-primary-foreground" : "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {labelH}:{pad(m)} {mer}
          </button>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedH, selectedM],
  );

  return (
    <div className="absolute inset-0 z-[60] flex origin-top flex-col bg-chrome clip-corner-lg animate-terminal-expand">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back"
            className="size-7 touch:size-10 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={commitAndClose}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-foreground">
            <Clock className="size-4 shrink-0 text-primary" />
            <span className="truncate">{formatLabel(draft, mode, placeholder)}</span>
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-7 shrink-0 gap-1 px-3 clip-corner-lg"
          onClick={commitAndClose}
        >
          <Check className="size-3.5" /> Set
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 items-center justify-center p-3">
          <MemoCalendar selectedDayMs={selectedDayMs} onSelect={setDay} />
        </div>
        {mode === "datetime" && (
          <div className="flex w-32 flex-col border-l border-border/60">
            <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Clock className="size-3.5" /> Time
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {timeList}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
