import { format } from "date-fns";
import { ArrowLeft, CalendarDays, Check, Clock } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** Format a Date as a `YYYY-MM-DD` string (local). */
function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a Date as a `YYYY-MM-DDTHH:mm` (datetime-local) string (local). */
function toDateTimeString(d: Date): string {
  return `${toDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` string into a local Date. */
function parseValue(value: string): Date | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

interface DateTimePickerProps {
  /** "date" → date only; "datetime" → date + time. */
  mode: "date" | "datetime";
  /** Current value as a `YYYY-MM-DD` (date) or `YYYY-MM-DDTHH:mm` (datetime) string. */
  value: string;
  onChange: (value: string) => void;
  /** Notifies the parent when the take-over panel opens/closes. */
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
 * Date (and optional time) picker. The trigger is a normal field button;
 * activating it expands a full-bleed panel over the enclosing dialog with a
 * terminal-style unfurl animation. The parent must be `relative` so the
 * `absolute inset-0` overlay fills it.
 *
 * Perf: the overlay keeps its own draft `Date` so picking a day/time re-renders
 * only the lightweight overlay — not the whole enclosing dialog. The value is
 * pushed up via `onChange` immediately (cheap string), but the expensive
 * Calendar is memoized so the time list and the calendar never re-render each
 * other.
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

/**
 * Memoized calendar. `selectedDayMs` is the selected day's UTC-midnight epoch
 * (a primitive), so changing only the *time* doesn't re-render the calendar at
 * all — react-day-picker's month-grid re-render is the expensive part.
 */
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
  // Local draft: picking is instant and only re-renders this overlay. The
  // value is pushed to the parent (a heavy dialog re-render) only on close, so
  // rapidly clicking dates/times never re-renders anything but this overlay.
  const [draft, setDraft] = useState<Date | undefined>(initial);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedH = draft?.getHours();
  const selectedM = draft?.getMinutes();
  // Day-only key for the calendar (stable across time-only changes).
  const selectedDayMs = useMemo(
    () => (draft ? new Date(draft.getFullYear(), draft.getMonth(), draft.getDate()).getTime() : undefined),
    [draft],
  );

  // Commit-on-close: keep the latest draft in a ref so the close handler is
  // stable and always flushes the freshest value.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commitAndClose = useCallback(() => {
    const d = draftRef.current;
    if (d) onChange(mode === "datetime" ? toDateTimeString(d) : toDateString(d));
    onClose();
  }, [mode, onChange, onClose]);

  // Stable handlers (functional updates) so MemoCalendar's props don't change
  // when only the time changes — keeping the heavy calendar from re-rendering.
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

  // Scroll the selected time into view once on open.
  useEffect(() => {
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "center" });
  }, []);

  // Close (committing the draft) on Escape.
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
