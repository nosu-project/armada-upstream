import { Calendar, CalendarDays, Check, Clock, HelpCircle, MapPin, X } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { dittoHashtagUrl } from "@/lib/dittoUrl";
import {
  type CalendarEvent,
  type CalendarTransport,
  formatCalendarEventWhen,
  isUpcoming,
  KIND_CALENDAR_TIME,
  type RsvpStatus,
  type RsvpTally,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

/** A small stacked avatar row for a set of RSVP'd pubkeys. */
function AttendeeAvatars({ pubkeys, max = 5 }: { pubkeys: string[]; max?: number }) {
  const shown = pubkeys.slice(0, max);
  const extra = pubkeys.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {shown.map((pk) => (
          <AttendeeAvatar key={pk} pubkey={pk} />
        ))}
      </div>
      {extra > 0 && <span className="ml-2 text-xs text-muted-foreground">+{extra}</span>}
    </div>
  );
}

function AttendeeAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <Avatar className="size-6 ring-2 ring-background">
      <AvatarImage src={author.data?.metadata?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
        {name.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

interface RsvpControlsProps {
  tally: RsvpTally;
  /** Whether the current user may RSVP (shows the Going/Maybe/Can't-go row). */
  canRsvp: boolean;
  isSettingRsvp: boolean;
  onSet: (status: RsvpStatus) => void;
}

/**
 * Going / Maybe / Can't-go controls plus the current attendee tallies. Purely
 * presentational — the tally + RSVP setter come from a {@link CalendarTransport}
 * (a relay query for NIP-29, the sealed chat fold for Concord).
 */
export function RsvpControls({ tally, canRsvp, isSettingRsvp, onSet }: RsvpControlsProps) {
  const { accepted, declined, tentative, mine: myStatus } = tally;

  const choose = (status: RsvpStatus) => {
    onSet(status);
  };

  return (
    <div className="space-y-3">
      {canRsvp && (
        <div className="grid grid-cols-3 gap-2">
          <RsvpButton
            active={myStatus === "accepted"}
            icon={<Check className="size-4" />}
            label="Going"
            tone="success"
            disabled={isSettingRsvp}
            onClick={() => choose("accepted")}
          />
          <RsvpButton
            active={myStatus === "tentative"}
            icon={<HelpCircle className="size-4" />}
            label="Maybe"
            tone="muted"
            disabled={isSettingRsvp}
            onClick={() => choose("tentative")}
          />
          <RsvpButton
            active={myStatus === "declined"}
            icon={<X className="size-4" />}
            label="Can't go"
            tone="destructive"
            disabled={isSettingRsvp}
            onClick={() => choose("declined")}
          />
        </div>
      )}

      <div className="space-y-2 text-sm">
        {accepted.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{accepted.length} going</span>
            <AttendeeAvatars pubkeys={accepted} />
          </div>
        )}
        {tentative.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{tentative.length} maybe</span>
            <AttendeeAvatars pubkeys={tentative} />
          </div>
        )}
        {declined.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{declined.length} can't go</span>
            <AttendeeAvatars pubkeys={declined} />
          </div>
        )}
        {accepted.length === 0 && tentative.length === 0 && declined.length === 0 && (
          <p className="text-xs text-muted-foreground">No RSVPs yet.</p>
        )}
      </div>
    </div>
  );
}

function RsvpButton({
  active,
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  tone: "success" | "muted" | "destructive";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneActive =
    tone === "success"
      ? "bg-success text-success-foreground hover:bg-success/90"
      : tone === "destructive"
        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
        : "bg-primary text-primary-foreground hover:bg-primary/90";
  const toneIdle =
    tone === "success"
      ? "bg-secondary/60 text-muted-foreground hover:bg-success/15 hover:text-success"
      : tone === "destructive"
        ? "bg-secondary/60 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        : "bg-secondary/60 text-muted-foreground hover:bg-primary/15 hover:text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-center gap-1.5 clip-corner-lg px-2 py-2 text-xs font-medium transition-colors disabled:opacity-60",
        active ? toneActive : toneIdle,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface CalendarEventMessageCardProps {
  event: CalendarEvent;
  tally: RsvpTally;
  /** Whether the current user may RSVP (membership / write access). */
  canRsvp: boolean;
  isSettingRsvp: boolean;
  onSetRsvp: (status: RsvpStatus) => void;
}

/**
 * An inline chat card for a calendar event (kind 31922/31923) — the Discord-like
 * "event" embed rendered in the message timeline. Transport-agnostic: the tally
 * and RSVP setter are supplied, so NIP-29 and Concord v2 render the same card
 * (the same events also list in {@link CalendarEventsBar}). Reuses
 * {@link RsvpControls} for the Going/Maybe/Can't-go row + attendee tallies.
 */
export function CalendarEventMessageCard({
  event,
  tally,
  canRsvp,
  isSettingRsvp,
  onSetRsvp,
}: CalendarEventMessageCardProps) {
  const past = !isUpcoming(event);
  return (
    <div className="max-w-md rounded-xl border border-border bg-secondary/20 px-3 py-2.5 my-1.5 space-y-2.5">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center clip-corner-lg",
            past ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary",
          )}
        >
          {event.kind === KIND_CALENDAR_TIME ? <Clock className="size-5" /> : <CalendarDays className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {past ? "Past event" : "Event"}
          </div>
          <h3 className="font-semibold leading-tight break-words">{event.title}</h3>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="size-3.5 shrink-0" />
            <span className="break-words">{formatCalendarEventWhen(event)}</span>
          </div>
          {event.location && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="size-3.5 shrink-0" />
              <span className="break-words">{event.location}</span>
            </div>
          )}
        </div>
      </div>

      {event.description && (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90 line-clamp-4">
          {event.description}
        </p>
      )}

      <RsvpControls tally={tally} canRsvp={canRsvp && !past} isSettingRsvp={isSettingRsvp} onSet={onSetRsvp} />
    </div>
  );
}

interface EventDetailDialogProps {
  calendar: CalendarTransport;
  event: CalendarEvent | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Full detail view of a single calendar event with RSVP controls. */
export function EventDetailDialog({ calendar, event, open, onOpenChange }: EventDetailDialogProps) {
  const organizer = useAuthor(event?.event.pubkey);
  const organizerName = useScopedDisplayName(event?.event.pubkey, organizer.data?.metadata);

  if (!event) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={event.title}>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
              {event.kind === KIND_CALENDAR_TIME ? <Clock className="size-5" /> : <CalendarDays className="size-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight break-words">{event.title}</h2>
              <p className="text-xs text-muted-foreground">
                Organized by <DisplayName pubkey={event?.event.pubkey} name={organizerName} />
              </p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="size-4 shrink-0" />
              <span>{formatCalendarEventWhen(event)}</span>
            </div>
            {event.location && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="size-4 shrink-0" />
                <span className="break-words">{event.location}</span>
              </div>
            )}
          </div>

          {event.description && (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{event.description}</p>
          )}

          {event.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {event.hashtags.map((t) => (
                <a
                  key={t}
                  href={dittoHashtagUrl(t)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  #{t}
                </a>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 pt-4">
            <RsvpControls
              tally={calendar.rsvpsFor(event)}
              canRsvp={calendar.canRsvp}
              isSettingRsvp={calendar.isSettingRsvp}
              onSet={(status) => calendar.setRsvp(event, status)}
            />
          </div>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
