import { CalendarDays, ChevronDown, Loader2, MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import {
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarTransport,
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_TIME,
  randomCalendarId,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

interface CreateEventDialogProps {
  calendar: CalendarTransport;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this event instead of creating a new one. */
  editing?: CalendarEvent;
}

type Mode = "time" | "date";

function localTzid(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toLocalInput(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Create or edit a NIP-52 calendar event (31923 time / 31922 date) in a NIP-29 group. Relay enforces admin-only. */
export function CreateEventDialog({ calendar, open, onOpenChange, editing }: CreateEventDialogProps) {
  const intl = useIntl();
  const { save, isSaving } = calendar;

  const [mode, setMode] = useState<Mode>("time");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setDescription(editing.description);
      setLocation(editing.location ?? "");
      setHashtags(editing.hashtags.join(" "));
      setDetailsOpen(
        Boolean(editing.end || editing.location || editing.description || editing.hashtags.length),
      );
      if (editing.kind === KIND_CALENDAR_TIME) {
        setMode("time");
        setStartAt(toLocalInput(Number(editing.start)));
        setEndAt(editing.end ? toLocalInput(Number(editing.end)) : "");
        setStartDate("");
        setEndDate("");
      } else {
        setMode("date");
        setStartDate(editing.start);
        setEndDate(editing.end ?? "");
        setStartAt("");
        setEndAt("");
      }
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      now.setHours(now.getHours() + 1);
      const startSec = Math.floor(now.getTime() / 1000);
      setMode("time");
      setDetailsOpen(false);
      setTitle("");
      setDescription("");
      setLocation("");
      setHashtags("");
      setStartAt(toLocalInput(startSec));
      setEndAt(toLocalInput(startSec + 3600));
      setStartDate("");
      setEndDate("");
    }
  }, [open, editing]);

  const canSave = useMemo(() => {
    if (!title.trim()) return false;
    if (mode === "time") return Boolean(startAt);
    return Boolean(startDate);
  }, [title, mode, startAt, startDate]);

  // Shift the end to preserve duration so it never lands before start.
  const handleStartAt = (next: string) => {
    const nextSec = fromLocalInput(next);
    const prevStartSec = fromLocalInput(startAt);
    const prevEndSec = fromLocalInput(endAt);
    setStartAt(next);
    if (nextSec === undefined) return;
    if (prevEndSec === undefined) {
      setEndAt(toLocalInput(nextSec + 3600));
      return;
    }
    const duration = prevStartSec !== undefined ? Math.max(prevEndSec - prevStartSec, 3600) : 3600;
    if (prevEndSec <= nextSec || prevStartSec !== undefined) {
      setEndAt(toLocalInput(nextSec + duration));
    }
  };

  const handleStartDate = (next: string) => {
    setStartDate(next);
    if (next && endDate && endDate < next) setEndDate("");
  };

  const handleSubmit = async () => {
    if (!canSave) return;

    const tags = hashtags
      .split(/[\s,#]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let input: CalendarEventInput;
    if (mode === "time") {
      const startSec = fromLocalInput(startAt);
      if (!startSec) {
        toast({ title: t({ id: "createEventDialog.pickStartTime", defaultMessage: "Pick a start time" }), variant: "destructive" });
        return;
      }
      const endSec = fromLocalInput(endAt);
      if (endSec !== undefined && endSec < startSec) {
        toast({ title: t({ id: "createEventDialog.endAfterStart", defaultMessage: "End must be after start" }), variant: "destructive" });
        return;
      }
      input = {
        identifier: editing?.identifier ?? randomCalendarId(),
        kind: KIND_CALENDAR_TIME,
        title: title.trim(),
        description: description.trim(),
        location: location.trim() || undefined,
        start: String(startSec),
        end: endSec !== undefined ? String(endSec) : undefined,
        startTzid: localTzid(),
        hashtags: tags,
      };
    } else {
      if (endDate && endDate < startDate) {
        toast({ title: t({ id: "createEventDialog.endAfterStart", defaultMessage: "End must be after start" }), variant: "destructive" });
        return;
      }
      input = {
        identifier: editing?.identifier ?? randomCalendarId(),
        kind: KIND_CALENDAR_DATE,
        title: title.trim(),
        description: description.trim(),
        location: location.trim() || undefined,
        start: startDate,
        end: endDate || undefined,
        hashtags: tags,
      };
    }

    try {
      await save(input, editing?.event);
      toast({
        title: editing
          ? t({ id: "createEventDialog.eventUpdated", defaultMessage: "Event updated" })
          : t({ id: "createEventDialog.eventCreated", defaultMessage: "Event created" }),
        description: title.trim(),
      });
      onOpenChange(false);
    } catch {
      // useCalendarEvents toasts the relay error.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={
          editing
            ? intl.formatMessage({ id: "createEventDialog.editTitle", defaultMessage: "Edit event" })
            : intl.formatMessage({ id: "createEventDialog.createTitle", defaultMessage: "Create an event" })
        }
        hideClose={pickerOpen}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <CalendarDays className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {editing ? <FormattedMessage id="createEventDialog.editHeading" defaultMessage="edit event" /> : <FormattedMessage id="createEventDialog.createHeading" defaultMessage="create an event" />}
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="createEventDialog.intro" defaultMessage="Schedule something for this channel. Members can RSVP." />
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="mt-6 space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="event-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="createEventDialog.what" defaultMessage="What" />
            </Label>
            <Input
              id="event-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={intl.formatMessage({ id: "createEventDialog.titlePlaceholder", defaultMessage: "Community call" })}
              maxLength={120}
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label
                htmlFor={mode === "time" ? "event-start" : "event-start-date"}
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                <FormattedMessage id="createEventDialog.when" defaultMessage="When" />
              </Label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <FormattedMessage id="createEventDialog.allDay" defaultMessage="All day" />
                <Switch checked={mode === "date"} onCheckedChange={(c) => setMode(c ? "date" : "time")} />
              </label>
            </div>
            {mode === "time" ? (
              <DateTimePicker id="event-start" mode="datetime" value={startAt} onChange={handleStartAt} onOpenChange={setPickerOpen} />
            ) : (
              <DateTimePicker id="event-start-date" mode="date" value={startDate} onChange={handleStartDate} onOpenChange={setPickerOpen} />
            )}
          </div>

          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")} />
            {detailsOpen ? <FormattedMessage id="createEventDialog.fewerDetails" defaultMessage="Fewer details" /> : <FormattedMessage id="createEventDialog.addDetails" defaultMessage="Add details" />}
            <span className="normal-case font-normal text-muted-foreground/70">
              <FormattedMessage id="createEventDialog.optional" defaultMessage="(optional)" />
            </span>
          </button>

          {detailsOpen && (
            <div className="space-y-4 border-l-2 border-border/60 pl-3">
              <div className="space-y-1.5">
                <Label
                  htmlFor={mode === "time" ? "event-end" : "event-end-date"}
                  className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  <FormattedMessage id="createEventDialog.ends" defaultMessage="Ends" />
                </Label>
                {mode === "time" ? (
                  <DateTimePicker id="event-end" mode="datetime" value={endAt} onChange={setEndAt} onOpenChange={setPickerOpen} />
                ) : (
                  <DateTimePicker id="event-end-date" mode="date" value={endDate} onChange={setEndDate} onOpenChange={setPickerOpen} />
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="event-location" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <FormattedMessage id="createEventDialog.location" defaultMessage="Location" />
                </Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="event-location"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder={intl.formatMessage({ id: "createEventDialog.locationPlaceholder", defaultMessage: "Voice channel, or a link / address" })}
                    maxLength={200}
                    className="pl-9"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="event-desc" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <FormattedMessage id="createEventDialog.description" defaultMessage="Description" />
                </Label>
                <Textarea
                  id="event-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={intl.formatMessage({ id: "createEventDialog.descriptionPlaceholder", defaultMessage: "What's happening?" })}
                  maxLength={2000}
                  rows={3}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="event-tags" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <FormattedMessage id="createEventDialog.tags" defaultMessage="Tags" />
                </Label>
                <Input
                  id="event-tags"
                  value={hashtags}
                  onChange={(e) => setHashtags(e.target.value)}
                  placeholder={intl.formatMessage({ id: "createEventDialog.tagsPlaceholder", defaultMessage: "weekly standup" })}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={isSaving || !canSave}>
              {isSaving ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                  {editing ? <FormattedMessage {...common.saving} /> : <FormattedMessage id="createEventDialog.creating" defaultMessage="Creating…" />}
                </>
              ) : (
                editing ? <FormattedMessage id="createEventDialog.saveChanges" defaultMessage="Save changes" /> : <FormattedMessage id="createEventDialog.createEvent" defaultMessage="Create event" />
              )}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
