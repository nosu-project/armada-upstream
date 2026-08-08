import { useQueryClient } from "@tanstack/react-query";
import { useQueries } from "@tanstack/react-query";
import { Ban, Crown, KeyRound, Loader2, Search, Shield, ShieldAlert, TriangleAlert, UserMinus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BanMemberDialog } from "@/concord/components/BanMemberDialog";
import { KickMembersDialog } from "@/concord/components/KickMembersDialog";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { useMembers } from "@/concord/hooks/useGuestbook";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useModeration } from "@/concord/hooks/useModeration";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { describeAttempts, type SuspiciousActor } from "@/concord/lib/auditLog";
import { KIND_COMMENT, KIND_MESSAGE } from "@/concord/lib/kinds";
import { banShouldRotateMany } from "@/concord/lib/control";
import {
  buildMemberRows,
  filterMemberRows,
  hoistSuspicious,
  type MemberDirectoryRow,
  type MemberSortKey,
  sortMemberRows,
} from "@/concord/lib/memberDirectory";
import { clickRow, emptySelection, pruneSelection, type SelectionState } from "@/concord/lib/rosterSelection";
import { badgeOf } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { authorQueryOptions, useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { profileMatches, type SearchProfile } from "@/hooks/useSearchProfiles";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { toast } from "@/hooks/useToast";
import { useEventStore } from "@/hooks/useEventStore";

/** Render cap before "Show all" — the house pattern is slicing, not virtualization. */
const RENDER_CAP = 150;

/**
 * The Members tab: the community's full roster — searchable, sortable,
 * filterable, multi-selectable — with mass moderation as the point.
 *
 * Epoch health (the old Member health view) lives on as one compact strip and
 * a filter: a member last seen posting under an older epoch never adopted a
 * key rotation, and "Send keys" re-hands them the current ones via a Direct
 * Invite. Detection is unchanged: observed message epochs only.
 */
export function MembersView({
  community,
  memberPubkeys,
  canModerate,
}: {
  community: Community;
  /** The page's memberlist — the keep-list a rotating mass ban preserves. */
  memberPubkeys: string[];
  canModerate: boolean;
}) {
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const channels = useChannels(community);
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  const { byChannel } = useCommunityRumors(community.idHex, channelIds);
  const { data: folded } = useControlFold(community);
  const moderation = useModeration(community, memberPubkeys);
  const { sendDirectInvite } = useInviteActions(community);
  // The control-plane watchdog: authors whose editions the fold refused. A
  // banned actor is the Banned view's story; here we surface the un-dealt-with.
  const { actors: suspiciousActors } = useSuspiciousActivity(community, folded);
  const suspiciousOf = useMemo(() => {
    const map = new Map<string, SuspiciousActor>();
    for (const a of suspiciousActors) if (!a.banned) map.set(a.author, a);
    return map;
  }, [suspiciousActors]);
  const suspiciousSet = useMemo(() => new Set(suspiciousOf.keys()), [suspiciousOf]);

  // Newest epoch + newest activity ms observed per author across all channels.
  const observed = useMemo(() => {
    const epochOf = new Map<string, bigint>();
    const seenMs = new Map<string, number>();
    for (const list of byChannel.values()) {
      for (const m of list) {
        if (m.kind !== KIND_MESSAGE && m.kind !== KIND_COMMENT) continue;
        const prevE = epochOf.get(m.author);
        if (prevE === undefined || m.epoch > prevE) epochOf.set(m.author, m.epoch);
        const prevMs = seenMs.get(m.author) ?? 0;
        if (m.ms > prevMs) seenMs.set(m.author, m.ms);
      }
    }
    return { epochOf, seenMs };
  }, [byChannel]);

  const { members, coalesced } = useMembers(community, observed.seenMs);

  // Muted people leave the roster like they leave every other list. This is
  // the one place that costs something — a moderator can't ban someone they
  // can't see — so the trade is stated rather than hidden: unmute from
  // Settings › Muted people, act, and mute again. Hiding them here but not in
  // the sidebar roster would be the worse answer, since this view is open to
  // every member, not just staff.
  const allRows = useMemo(
    () =>
      buildMemberRows({
        members,
        coalesced,
        observedEpochOf: observed.epochOf,
        observedSeenMs: observed.seenMs,
        roster: folded?.roster,
        currentEpoch: community.rootEpoch,
        ownerHex: folded?.ownerHex ?? community.owner,
        selfHex: user?.pubkey,
        suspicious: suspiciousSet,
      }).filter((row) => !mutedPubkeys.has(row.pubkey)),
    [members, coalesced, observed, folded, community, user, suspiciousSet, mutedPubkeys],
  );

  // ── Search / filter / sort state ──────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<MemberSortKey>("role");
  const [roleFilter, setRoleFilter] = useState<string>("all"); // "all" | "none" | roleId
  const [behindOnly, setBehindOnly] = useState(false);
  const [suspiciousOnly, setSuspiciousOnly] = useState(false);
  const [inviterFilter, setInviterFilter] = useState<string>("all"); // "all" | "any" | creator hex
  const [showAll, setShowAll] = useState(false);

  // Batch-resolve profiles for the whole roster so search and the name map see
  // every member, not just rows that happen to have rendered (the
  // useMentionNameMap pattern; results land in the shared ['author', pk] cache).
  const pubkeys = useMemo(() => allRows.map((r) => r.pubkey), [allRows]);
  const profileResults = useQueries({
    queries: pubkeys.map((pk) => authorQueryOptions(queryClient, eventStore, pk)),
  });
  // Stable serialization: the map identity changes only when a resolved
  // profile actually changes, not on every render as query objects churn.
  const profileKey = pubkeys
    .map((pk, i) => `${pk}:${profileResults[i]?.data?.metadata?.name ?? ""}:${profileResults[i]?.data?.metadata?.display_name ?? ""}:${profileResults[i]?.data?.metadata?.nip05 ?? ""}`)
    .join("|");
  const profileOf = useMemo(() => {
    const map = new Map<string, SearchProfile>();
    pubkeys.forEach((pk, i) => {
      const data = profileResults[i]?.data;
      if (data?.metadata && data.event) map.set(pk, { pubkey: pk, metadata: data.metadata, event: data.event });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  const rows = useMemo(() => {
    const filtered = filterMemberRows(allRows, {
      query,
      nameMatch: (pk, q) => {
        const p = profileOf.get(pk);
        return p ? profileMatches(p, q) : false;
      },
      roleIds: roleFilter !== "all" && roleFilter !== "none" ? [roleFilter] : undefined,
      noRole: roleFilter === "none",
      behindOnly,
      suspiciousOnly,
      viaInvite: inviterFilter === "any",
      inviter: inviterFilter !== "all" && inviterFilter !== "any" ? inviterFilter : undefined,
    });
    // The alarm outranks every sort key: flagged rows ride on top.
    return hoistSuspicious(sortMemberRows(filtered, sortKey));
  }, [allRows, query, roleFilter, behindOnly, suspiciousOnly, inviterFilter, sortKey, profileOf]);

  const visible = showAll ? rows : rows.slice(0, RENDER_CAP);
  const visibleOrder = useMemo(() => visible.map((r) => r.pubkey), [visible]);

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selection, setSelection] = useState<SelectionState>(emptySelection());

  // A changed filter hides rows; hidden-but-selected members must not ride
  // invisibly into a mass action, so the selection resets outright.
  const filterSig = `${query}|${roleFilter}|${behindOnly}|${suspiciousOnly}|${inviterFilter}`;
  const prevFilterSig = useRef(filterSig);
  useEffect(() => {
    if (prevFilterSig.current !== filterSig) {
      prevFilterSig.current = filterSig;
      setSelection(emptySelection());
    }
  }, [filterSig]);
  // Roster churn (a member left, was banned elsewhere) prunes instead.
  const visibleSet = useMemo(() => new Set(visibleOrder), [visibleOrder]);
  useEffect(() => {
    setSelection((s) => pruneSelection(s, visibleSet));
  }, [visibleSet]);

  const selected = useMemo(
    () => visible.filter((r) => selection.selected.has(r.pubkey)).map((r) => r.pubkey),
    [visible, selection],
  );
  const kickable = selected.filter((pk) => moderation.canKick(pk));
  const bannable = selected.filter((pk) => moderation.canBan(pk));
  const healTargets = useMemo(() => {
    const behind = new Set(visible.filter((r) => r.behind).map((r) => r.pubkey));
    return selected.filter((pk) => behind.has(pk) && pk !== user?.pubkey);
  }, [visible, selected, user]);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selection.selected.has(r.pubkey));
  const someVisibleSelected = visible.some((r) => selection.selected.has(r.pubkey));
  const toggleAllVisible = () => {
    setSelection((s) => {
      const next = new Set(s.selected);
      if (allVisibleSelected) for (const pk of visibleOrder) next.delete(pk);
      else for (const pk of visibleOrder) next.add(pk);
      return { selected: next, anchor: s.anchor };
    });
  };

  // ── Mass actions ──────────────────────────────────────────────────────────
  const [kickTargets, setKickTargets] = useState<string[] | null>(null);
  const [banTargets, setBanTargets] = useState<string[] | null>(null);
  const [healing, setHealing] = useState<{ done: number; total: number } | null>(null);

  const banWillRotate =
    banTargets !== null &&
    !!folded &&
    !!user &&
    banShouldRotateMany(folded, user.pubkey, banTargets) &&
    moderation.canRekey;

  const runMassHeal = async () => {
    if (healTargets.length === 0 || healing) return;
    setHealing({ done: 0, total: healTargets.length });
    let sent = 0;
    const failed: string[] = [];
    // Sequential on purpose: each invite is a signer round-trip plus an inbox
    // relay lookup, and a remote signer hammered in parallel wedges.
    for (const [i, pk] of healTargets.entries()) {
      try {
        await sendDirectInvite({ recipientPubkey: pk });
        sent += 1;
      } catch {
        failed.push(pk);
      }
      setHealing({ done: i + 1, total: healTargets.length });
    }
    setHealing(null);
    setSelection(emptySelection());
    toast({
      title: `Sent current keys to ${sent} member${sent === 1 ? "" : "s"}`,
      description: failed.length > 0 ? `${failed.length} failed — try them again shortly.` : undefined,
      variant: failed.length > 0 ? "destructive" : undefined,
    });
  };

  const inviters = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.invite) set.add(r.invite.creator);
    return [...set].sort();
  }, [allRows]);
  const behindCount = allRows.filter((r) => r.behind).length;
  const roles = useMemo(
    () => [...(folded?.roster.roles ?? [])].sort((a, b) => a.position - b.position),
    [folded],
  );

  // Viewport breakpoints lie inside panes, so "is this list cramped?" has to be
  // measured off the pane itself. Compact drops the joined chip; minimal (the
  // sidebar-beside-pane squeeze) drops the times entirely — name and rank
  // survive, everything else lives in tooltips and the sort.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<"full" | "compact" | "minimal">("full");
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setDensity(w < 280 ? "minimal" : w < 470 ? "compact" : "full");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-3xl space-y-4 p-4 pb-24">
      <div className="flex items-center gap-2">
        <Users className="size-5 text-primary" />
        <h2 className="text-lg font-semibold">Members</h2>
        <span className="text-sm text-muted-foreground">{allRows.length}</span>
      </div>

      {suspiciousSet.size > 0 && (
        <button
          type="button"
          onClick={() => setSuspiciousOnly((v) => !v)}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
            suspiciousOnly ? "bg-destructive/25 text-destructive" : "bg-destructive/10 text-destructive"
          }`}
        >
          <ShieldAlert className="size-4 shrink-0" />
          {suspiciousSet.size} member{suspiciousSet.size === 1 ? " has" : "s have"} tried to make
          changes they aren't allowed to. Nothing worked, but they're worth a look.
          <span className="ml-auto shrink-0 text-xs underline">{suspiciousOnly ? "Show all" : "Show them"}</span>
        </button>
      )}

      {behindCount > 0 && (
        <button
          type="button"
          onClick={() => setBehindOnly((v) => !v)}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
            behindOnly ? "bg-amber-500/20 text-amber-700 dark:text-amber-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }`}
        >
          <TriangleAlert className="size-4 shrink-0" />
          {behindCount} member{behindCount === 1 ? " was" : "s were"} last seen on an older epoch — they
          never adopted a key rotation.
          <span className="ml-auto shrink-0 text-xs underline">{behindOnly ? "Show all" : "Show them"}</span>
        </button>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            className="pl-8"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-36 shrink-0">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every role</SelectItem>
            {roles.map((r) => (
              <SelectItem key={r.roleId} value={r.roleId}>
                {r.name}
              </SelectItem>
            ))}
            <SelectItem value="none">No role</SelectItem>
          </SelectContent>
        </Select>
        {inviters.length > 0 && (
          <Select value={inviterFilter} onValueChange={setInviterFilter}>
            <SelectTrigger className="w-40 shrink-0">
              <SelectValue placeholder="Invited by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any arrival</SelectItem>
              <SelectItem value="any">Invited (any link)</SelectItem>
              {inviters.map((pk) => (
                <SelectItem key={pk} value={pk}>
                  by <InviterName pubkey={pk} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as MemberSortKey)}>
          <SelectTrigger className="w-40 shrink-0">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="role">By role</SelectItem>
            <SelectItem value="seen">Recently seen</SelectItem>
            <SelectItem value="joined-newest">Newest members</SelectItem>
            <SelectItem value="joined-oldest">Oldest members</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {canModerate && visible.length > 0 && (
        <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
          <Checkbox
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={toggleAllVisible}
          />
          Select all shown
        </label>
      )}

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-foreground/5 px-4 py-8 text-sm text-muted-foreground">
          <Users className="size-5" />
          {allRows.length === 0 ? "No members observed yet." : "No members match."}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((row) => (
            <MemberRow
              key={row.pubkey}
              row={row}
              density={density}
              currentEpoch={community.rootEpoch}
              selectable={canModerate}
              selected={selection.selected.has(row.pubkey)}
              onToggle={(shiftKey) => setSelection((s) => clickRow(s, visibleOrder, row.pubkey, shiftKey))}
              roleNames={roles.filter((r) => row.roleIds.includes(r.roleId)).map((r) => r.name)}
              badge={folded ? badgeOf(folded.roster, row.pubkey) : undefined}
              suspicion={suspiciousOf.get(row.pubkey)}
            />
          ))}
        </ul>
      )}

      {!showAll && rows.length > RENDER_CAP && (
        <Button type="button" variant="outline" className="w-full" onClick={() => setShowAll(true)}>
          Show all {rows.length}
        </Button>
      )}

      {/* Bulk action bar */}
      {canModerate && selected.length > 0 && (
        <div className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur pb-safe">
          <span className="text-sm font-medium">{selected.length} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {healTargets.length > 0 && (
              <Button type="button" size="sm" variant="outline" disabled={healing !== null} onClick={runMassHeal}>
                {healing ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Sending {healing.done}/{healing.total}
                  </>
                ) : (
                  <>
                    <KeyRound className="size-3.5" />
                    Send keys ({healTargets.length})
                  </>
                )}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={kickable.length === 0}
              onClick={() => setKickTargets(kickable)}
            >
              <UserMinus className="size-3.5" />
              Kick{kickable.length > 0 ? ` (${kickable.length})` : ""}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={bannable.length === 0}
              onClick={() => setBanTargets(bannable)}
            >
              <Ban className="size-3.5" />
              Ban{bannable.length > 0 ? ` (${bannable.length})` : ""}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelection(emptySelection())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <KickMembersDialog
        targets={kickTargets}
        ineligible={selected.filter((pk) => !moderation.canKick(pk))}
        onClose={() => {
          setKickTargets(null);
          setSelection(emptySelection());
        }}
        onConfirm={async (targets, onProgress) => {
          const result = await moderation.kickMany({ targets, onProgress });
          if (result.failed.length === 0) {
            toast({
              title: `Kicked ${result.kicked.length} member${result.kicked.length === 1 ? "" : "s"}`,
            });
          }
          return result;
        }}
      />
      <BanMemberDialog
        targets={banTargets}
        ineligible={selected.filter((pk) => !moderation.canBan(pk))}
        willRotate={banWillRotate}
        onClose={() => {
          setBanTargets(null);
          setSelection(emptySelection());
        }}
        onConfirm={async (targets, onPhase, onStripProgress) => {
          const { rekeyed, publicBan, banned } = await moderation.banMany({ targets, onPhase, onStripProgress });
          const who = `${banned.length} member${banned.length === 1 ? "" : "s"}`;
          if (rekeyed || publicBan) {
            toast({ title: `Banned ${who}`, description: "They are silenced for everyone in this community." });
          } else {
            toast({
              title: `Banned ${who}`,
              description: "They're silenced; the final lock-out will finish on your next visit.",
            });
          }
        }}
      />
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

const JOIN_PROVENANCE: Record<MemberDirectoryRow["joinKind"], string> = {
  join: "From their own join.",
  snapshot: "Estimated — carried over by a key rotation, so this is the rotation's time, not the true join.",
  observed: "Unknown — inferred from activity; no join was observed.",
};

function MemberRow({
  row,
  density,
  currentEpoch,
  selectable,
  selected,
  onToggle,
  roleNames,
  badge,
  suspicion,
}: {
  row: MemberDirectoryRow;
  density: "full" | "compact" | "minimal";
  currentEpoch: bigint;
  selectable: boolean;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  roleNames: string[];
  badge: "admin" | "moderator" | undefined;
  suspicion: SuspiciousActor | undefined;
}) {
  const author = useAuthor(row.pubkey);
  const name = useScopedDisplayName(row.pubkey, author.data?.metadata);

  return (
    <li
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
        row.suspicious
          ? selected
            ? "bg-destructive/25"
            : "bg-destructive/10"
          : selected
            ? "bg-primary/10"
            : "bg-foreground/5"
      } ${selectable ? "cursor-pointer select-none" : ""}`}
      onClick={selectable ? (e) => onToggle(e.shiftKey) : undefined}
      // Shift-click must range-select, not highlight text.
      onMouseDown={selectable ? (e) => e.shiftKey && e.preventDefault() : undefined}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          // One handler, not onCheckedChange too — both fire on a click and
          // would toggle twice. Radix renders a button, so keyboard activation
          // also arrives here as a click.
          onClick={(e) => {
            e.stopPropagation();
            onToggle(e.shiftKey);
          }}
          aria-label={`Select ${name}`}
        />
      )}
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-[10px] text-primary">
          {name[0]?.toUpperCase() ?? "?"}
        </AvatarFallback>
      </Avatar>
      {/* flex-auto, not flex-1: with basis 0% the name only gets leftover space
          and a tight row crushes it to nothing while the time chips hold width.
          Basis auto starts everyone at natural size, then the chips' higher
          shrink factors make THEM give way first. */}
      <span className="min-w-0 flex-auto truncate font-medium">
        <DisplayName pubkey={row.pubkey} name={name} />
        {row.isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
      </span>

      {suspicion && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              <ShieldAlert className="size-3 shrink-0" />
              <span className="truncate">Suspicious</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60 text-xs">
            Tried to make {describeAttempts(suspicion.attempts)} without permission. None of it
            worked — nothing in the community actually changed.
          </TooltipContent>
        </Tooltip>
      )}
      {row.isOwner && (
        <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
          <Crown className="size-3 shrink-0" />
          <span className="truncate">Owner</span>
        </span>
      )}
      {!row.isOwner && badge && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                badge === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              <Shield className="size-3 shrink-0" />
              <span className="truncate">{badge === "admin" ? "Admin" : "Mod"}</span>
            </span>
          </TooltipTrigger>
          {roleNames.length > 0 && (
            <TooltipContent className="max-w-52 text-xs">{roleNames.join(", ")}</TooltipContent>
          )}
        </Tooltip>
      )}

      {/* Compact time chips that SHRINK (min-w-0 + truncate) before the name
          does — viewport breakpoints lie inside panes, so the squeeze has to
          come from flex, not from sm:/md:. Higher shrink factors give way first. */}
      {density === "full" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 shrink-[3] truncate text-xs tabular-nums text-muted-foreground">
              {row.joinMs !== undefined ? `joined ${shortTimeAgo(Math.floor(row.joinMs / 1000))}` : "join unknown"}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56 space-y-0.5 text-xs">
            {row.joinMs !== undefined && <p>{new Date(row.joinMs).toLocaleString()}</p>}
            <p>{JOIN_PROVENANCE[row.joinKind]}</p>
            {row.invite && (
              <p>
                Invited by <InviterName pubkey={row.invite.creator} />
                {row.invite.label ? ` through "${row.invite.label}"` : ""}.
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {density === "full" && row.invite && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 shrink-[4] truncate text-xs text-muted-foreground">
              via <InviterName pubkey={row.invite.creator} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56 text-xs">
            Joined through {row.invite.label ? `the "${row.invite.label}" invite link` : "an invite link"} created
            by <InviterName pubkey={row.invite.creator} />.
          </TooltipContent>
        </Tooltip>
      )}
      {density !== "minimal" && (
        <span
          className="min-w-0 shrink-[2] truncate text-xs tabular-nums text-muted-foreground"
          title={row.lastSeenMs > 0 ? new Date(row.lastSeenMs).toLocaleString() : undefined}
        >
          {row.lastSeenMs > 0 ? `seen ${shortTimeAgo(Math.floor(row.lastSeenMs / 1000))}` : "not seen"}
        </span>
      )}

      {row.behind && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3" />
              epoch {row.epoch?.toString()}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-52 text-xs">
            Last seen posting under epoch {row.epoch?.toString()}, but the community is on{" "}
            {currentEpoch.toString()}. Select them and use Send keys to catch them up.
          </TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

function InviterName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <>{name}</>;
}
