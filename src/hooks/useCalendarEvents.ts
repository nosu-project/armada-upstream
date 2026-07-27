import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useToast } from "@/hooks/useToast";
import {
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarTransport,
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_RSVP,
  KIND_CALENDAR_TIME,
  calendarEventCoord,
  parseCalendarEvents,
  parseRsvpStatus,
  type RsvpStatus,
  type RsvpTally,
  type RsvpVote,
  tallyRsvps,
} from "@/lib/calendar";
import {
  buildCalendarEventTags,
  buildRsvpTags,
  KIND_DELETE,
  parseRsvpCoord,
  relayRejectionMessage,
} from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

export { isUpcoming } from "@/lib/calendar";

/**
 * A group's NIP-52 calendar events (kinds 31922/31923). Queries the group's
 * host relay (group traffic stays on one relay) and exposes create/update and
 * delete mutations, gated relay-side to admins/moderators. Events are
 * addressable, so the newest event per (author, kind, `d`) wins; the list is
 * sorted soonest-first.
 */
export function useCalendarEvents(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();

  const queryKey = ["nip29", "calendar", relayUrl, groupId];

  const query = useQuery<CalendarEvent[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        // `#h` routes the query into the group's DB (relay29 only serves
        // filters carrying an h/e/a/ids selector). Both calendar kinds in one
        // filter.
        [{ kinds: [KIND_CALENDAR_DATE, KIND_CALENDAR_TIME], "#h": [groupId!], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return parseCalendarEvents(events);
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const events = query.data ?? [];

  const save = useMutation({
    mutationFn: async ({ input, prev }: { input: CalendarEventInput; prev?: NostrEvent }) => {
      return publishEvent({
        kind: input.kind,
        content: input.description ?? "",
        tags: buildCalendarEventTags(groupId!, input),
        relay: relayUrl,
        prev,
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't save event",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: async (event: CalendarEvent) => {
      return publishEvent({
        kind: KIND_DELETE,
        content: "",
        tags: [
          ["e", event.event.id],
          ["k", String(event.kind)],
          ["h", groupId!],
        ],
        relay: relayUrl,
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't delete event",
        description: relayRejectionMessage(err),
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    events,
    isLoading: query.isLoading,
    /** Create a new event, or update an existing one (pass its raw event as `prev`). */
    save: (input: CalendarEventInput, prev?: NostrEvent) => save.mutateAsync({ input, prev }),
    isSaving: save.isPending,
    /** Delete an event (NIP-09 kind 5, author/moderator only per the relay). */
    remove: (event: CalendarEvent) => remove.mutateAsync(event),
    isRemoving: remove.isPending,
  };
}

/** All RSVPs for a group's events, keyed by the event coordinate they point at. */
type RsvpMap = Map<string, RsvpVote[]>;

const EMPTY_RSVPS: RsvpVote[] = [];

/**
 * Build a NIP-29 {@link CalendarTransport}: the group's events plus its RSVPs
 * (one bulk query, tallied client-side per event), and the create/delete/RSVP
 * mutations. GroupPage hands this to the shared calendar UI, which is otherwise
 * transport-agnostic (Concord supplies the same shape from its sealed fold).
 */
export function useNip29CalendarTransport(
  relayUrl: string | undefined,
  groupId: string | undefined,
  canModerate: boolean,
): CalendarTransport {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();
  const { events, save, remove, isSaving } = useCalendarEvents(relayUrl, groupId);

  const rsvpKey = ["nip29", "rsvps", relayUrl, groupId];

  const rsvpQuery = useQuery<RsvpMap>({
    queryKey: rsvpKey,
    queryFn: async ({ signal }) => {
      const rsvps = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_CALENDAR_RSVP], "#h": [groupId!], limit: 1000 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const map: RsvpMap = new Map();
      for (const rsvp of rsvps) {
        const coord = parseRsvpCoord(rsvp);
        const status = parseRsvpStatus(rsvp);
        if (!coord || !status) continue;
        const list = map.get(coord) ?? [];
        list.push({ pubkey: rsvp.pubkey, status, ms: rsvp.created_at * 1000 });
        map.set(coord, list);
      }
      return map;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const rsvpMap = rsvpQuery.data;

  const rsvpsFor = useCallback(
    (event: CalendarEvent): RsvpTally => {
      const coord = calendarEventCoord(event.kind, event.event.pubkey, event.identifier);
      return tallyRsvps(rsvpMap?.get(coord) ?? EMPTY_RSVPS, user?.pubkey);
    },
    [rsvpMap, user?.pubkey],
  );

  const setRsvp = useMutation({
    mutationFn: async ({ event, status }: { event: CalendarEvent; status: RsvpStatus }) => {
      const coord = calendarEventCoord(event.kind, event.event.pubkey, event.identifier);
      return publishEvent({
        kind: KIND_CALENDAR_RSVP,
        content: "",
        tags: buildRsvpTags({
          groupId: groupId!,
          eventCoord: coord,
          eventId: event.event.id,
          eventAuthor: event.event.pubkey,
          status,
        }),
        relay: relayUrl,
      });
    },
    onMutate: async ({ event, status }) => {
      if (!user) return;
      await queryClient.cancelQueries({ queryKey: rsvpKey });
      const prev = queryClient.getQueryData<RsvpMap>(rsvpKey);
      const coord = calendarEventCoord(event.kind, event.event.pubkey, event.identifier);
      // Optimistically reflect the new status (newest ms wins in the tally).
      const next: RsvpMap = new Map(prev);
      const list = (next.get(coord) ?? []).filter((v) => v.pubkey !== user.pubkey);
      list.push({ pubkey: user.pubkey, status, ms: Date.now() });
      next.set(coord, list);
      queryClient.setQueryData<RsvpMap>(rsvpKey, next);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(rsvpKey, ctx.prev);
      toast({ title: "RSVP failed", description: relayRejectionMessage(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: rsvpKey });
    },
  });

  return {
    events,
    canModerate,
    canRsvp: Boolean(user),
    isSaving,
    isSettingRsvp: setRsvp.isPending,
    save: (input, prev) => save(input, prev).then(() => undefined),
    remove: (event) => remove(event).then(() => undefined),
    rsvpsFor,
    setRsvp: (event, status) => void setRsvp.mutateAsync({ event, status }).catch(() => {}),
  };
}
