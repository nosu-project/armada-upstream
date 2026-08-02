import { GripVertical, Hash, Loader2, Plus, Shield, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { DisplayName } from "@/components/DisplayName";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRoles2 } from "@/concord-v2/hooks/useRoles2";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import {
  byDisplayOrder,
  canActOnMember,
  canActOnPosition,
  colorToHex,
  emptyRoles,
  hexToColor,
  highestPosition,
  MAX_ROLES_PER_COMMUNITY,
  normalizeOrder,
  PERMISSION_LABELS,
  Permissions,
  projectReorder,
  type MemberGrant,
  type Role,
  type RoleScope,
} from "@/concord-v2/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { cn } from "@/lib/utils";

/** Fallback swatch for a role still on the theme default (`color === 0`). */
const DEFAULT_SWATCH = "#5865f2";

/** A member's display name, for naming the holders a revoke cannot reach. */
function MemberLabel({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <DisplayName pubkey={pubkey} name={name || pubkey.slice(0, 8)} />;
}

/** Comma-separated member names. */
function MemberNames({ members }: { members: MemberGrant[] }) {
  return (
    <>
      {members.map((g, i) => (
        <span key={g.member}>
          {i > 0 && ", "}
          <MemberLabel pubkey={g.member} />
        </span>
      ))}
    </>
  );
}

/**
 * Role management for a Concord V2 community: create roles, edit names and
 * permission bits. Each save publishes a version-chained Role (vsk 1) edition;
 * every member's fold re-checks MANAGE_ROLES + strict outrank (CORD-04).
 */
export function RolesDialog2({
  community,
  open,
  onOpenChange,
}: {
  community: CommunityV2 | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Roles</DialogTitle>
        <div className="clip-corner-lg bg-chrome p-6 sm:p-7">
          {community && <RolesBody community={community} />}
        </div>
        <ArmadaCrestKeyframes />
      </DialogContent>
    </Dialog>
  );
}

function RolesBody({ community }: { community: CommunityV2 }) {
  const { folded, saveRole, isSavingRole, setMemberRoles, isSettingRoles, newRoleId } = useRoles2(community);
  const { user } = useCurrentUser();
  const [editing, setEditing] = useState<Role | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  /**
   * A refused order, held as role ids rather than Roles: the fold can advance
   * between the refusal and the click, and a plan computed against the old
   * roster would write positions derived from roles that have since moved.
   */
  const [evenOut, setEvenOut] = useState<string[] | null>(null);

  const roster = folded?.roster ?? emptyRoles();
  const actor = user?.pubkey;
  const busy = isSavingRole || isSettingRoles;

  const roles = useMemo(
    () => [...(folded?.roster.roles ?? [])].sort(byDisplayOrder),
    [folded],
  );

  // Live channels a role can scope to; a role's channel is looked up here for
  // the list row's "# name" hint (deleted channels fall back to a stub label).
  const channels = useMemo(
    () => [...(folded?.channels.values() ?? [])].filter((c) => !c.deleted),
    [folded],
  );
  const channelName = (channelId: string) =>
    folded?.channels.get(channelId)?.name ?? "deleted channel";

  const ownerHex = folded?.ownerHex ?? community.owner;

  /**
   * May the actor rewrite a Role sitting at `position`? Same gate the fold
   * applies when judging a Role edition (CORD-04 §3 strict outrank), so
   * publishing a move the network would drop fails HERE with a readable
   * message instead.
   */
  const mayTouch = (position: number) =>
    Boolean(actor && canActOnPosition(roster, actor, ownerHex, position, Permissions.MANAGE_ROLES));

  /**
   * The lowest position this actor may claim: strictly below their own rank is
   * forbidden, so rank + 1 — and 1 for the owner, who outranks everything but
   * still may not mint position 0 (CORD-04 §3). null when they hold no role at
   * all and so may not write any position.
   */
  const writableFloor = useMemo(() => {
    if (!actor) return null;
    if (actor === ownerHex) return 1;
    const rank = highestPosition(roster, actor);
    return rank === undefined ? null : rank + 1;
  }, [actor, ownerHex, roster]);

  /**
   * May the actor rewrite THIS MEMBER's Grant? Outranking the role is not
   * enough: a Grant edition hands out every role the member keeps, so stripping
   * one role from someone who outranks the actor still publishes an edition
   * claiming their higher-ranked roles, which every fold drops (CORD-04 §3).
   * Relays accept it regardless, so nothing throws — the check has to be here.
   */
  const mayStrip = (member: string) =>
    Boolean(actor && canActOnMember(roster, actor, ownerHex, member, Permissions.MANAGE_ROLES));

  /**
   * The grants holding `role`, split by whether the actor may rewrite them.
   * `skippedOwner` separates the owner: `canActOnMember` refuses them as a
   * target outright (supreme and never removable, CORD-04 §3), which is a
   * different fact from "you don't outrank them" — and would read as nonsense
   * when the owner is the one revoking.
   */
  const holdersOf = (role: Role) => {
    const holders = roster.grants.filter((g) => g.roleIds.includes(role.roleId));
    const blocked = holders.filter((g) => !mayStrip(g.member));
    return {
      strippable: holders.filter((g) => mayStrip(g.member)),
      skipped: blocked,
      skippedOwner: blocked.filter((g) => g.member === ownerHex),
      skippedRank: blocked.filter((g) => g.member !== ownerHex),
    };
  };

  /**
   * Commit a reordering. The multiset of existing `position` values is REUSED,
   * reassigned to roles in the new visual order, rather than renumbering 1..N:
   * renumbering would try to write position 1, which an actor ranked at 1
   * cannot claim (no edition may claim a position at or above its own signer),
   * so a legal reshuffle of the lower ranks would fail for everyone but the
   * owner. Only the roles whose position actually changed are republished.
   */
  const commitOrder = async (next: Role[]) => {
    setError(null);
    setEvenOut(null);
    const { landing, rendered } = projectReorder(roles, next);
    const moved = next
      .map((role, i) => ({ role, position: landing[i].position }))
      .filter(({ role, position }) => role.position !== position);
    // Reusing the position multiset cannot separate peers, so the request is
    // either satisfiable or it is not — there is no partial version of it. Two
    // shapes: the reassignment changes no position at all (a shuffle purely
    // among peers), or it changes some but the §3 tie-break still renders an
    // order other than the one dropped, as with A(3) B(3) C(5) dragging C to
    // the top. Both are caught here, before anything is published.
    const missed = rendered.findIndex((role, i) => role.roleId !== next[i].roleId);
    if (missed < 0 && moved.length === 0) return; // already in the order asked for
    if (moved.length === 0 || missed >= 0) {
      setError(unsatisfiable(next, landing, rendered, missed));
      // The escape. Without it a roster where every role shares one position
      // has no reachable order at all and no position control to fix it by
      // hand. Offer it rather than applying it: it rewrites the position of
      // roles the user did not drag.
      if (planEvenOut(next)) setEvenOut(next.map((r) => r.roleId));
      return;
    }
    await applyMoves(moved);
  };

  /**
   * Why a requested order cannot be reached, named in terms of the roles the
   * user can see. "Move it past a role at a different position" is the wrong
   * advice here — that is exactly what they just did; the point is that the
   * position it would take is not free, so the tie-break decides instead.
   */
  const unsatisfiable = (next: Role[], landing: Role[], rendered: Role[], missed: number) => {
    const wanted = landing.find((r) => r.roleId === next[missed].roleId)!;
    const peers = landing.filter((r) => r.position === wanted.position && r.roleId !== wanted.roleId);
    const ahead = rendered.slice(0, rendered.findIndex((r) => r.roleId === wanted.roleId));
    const winner = ahead[ahead.length - 1];
    return `${wanted.name} can't go there: the only position free for it is ${wanted.position}, which ${peers
      .map((r) => r.name)
      .join(" and ")} already ${peers.length === 1 ? "holds" : "hold"}, and a tie is decided by the lower role id — so it would render${
      winner ? ` behind ${winner.name}` : " out of order"
    }, not where you dropped it. Nothing was published.`;
  };

  /**
   * Publish a set of position rewrites. Each role is its own version-chained
   * entity, so this is a sequence of independent publishes, not a transaction.
   * There is no rollback to build — if one fails, say exactly how far it got.
   */
  const applyMoves = async (moved: Array<{ role: Role; position: number }>) => {
    // A move rewrites the role at both ends of the swap, so the actor must
    // outrank where it sat AND where it lands.
    for (const { role, position } of moved) {
      if (!mayTouch(role.position) || !mayTouch(position)) {
        setError("That move crosses your own rank.");
        return;
      }
    }
    let done = 0;
    try {
      for (const { role, position } of moved) {
        await saveRole({ role: { ...role, position } });
        done++;
      }
      toast({ title: "Order updated" });
    } catch (e) {
      const why = e instanceof Error ? e.message : "Couldn't reorder roles.";
      // A half-applied swap can leave two roles on one position — legal (§3
      // permits peers) but confusing: the role_id tie-break may then render the
      // list in its ORIGINAL order, so the move reads as fully undone, and
      // dragging the pair again is a no-op. Name that landing instead of
      // telling them to "reorder again to finish", which dead-ends there.
      const landed = new Map(roles.map((r) => [r.roleId, r.position]));
      for (let i = 0; i < done; i++) landed.set(moved[i].role.roleId, moved[i].position);
      const seen = new Set<number>();
      const shared = [...new Set([...landed.values()].filter((p) => seen.size === seen.add(p).size))].sort(
        (a, b) => a - b,
      );
      setError(
        shared.length > 0
          ? `${why} ${done} of ${moved.length} roles moved, leaving two or more roles on position ${shared.join(" and ")}. Nothing was undone. Roles at one position are peers and render by role id, so the list may look unchanged — drag one of them again and take the offer to even out the positions.`
          : `${why} ${done} of ${moved.length} roles moved; the rest kept their old position. Nothing was undone — reorder again to finish.`,
      );
    }
  };

  /**
   * A distinct position for every role, in the requested order — or null if
   * this actor cannot write the positions it would take. Computed against the
   * roster as it is right now, both when offering the escape and when applying
   * it, so a fold that lands in between is caught rather than published over.
   */
  const planEvenOut = (next: Role[]): Role[] | null => {
    if (writableFloor === null) return null;
    const plan = normalizeOrder(next, writableFloor);
    if (!plan) return null;
    // Gate the roles whose position CHANGES, not the whole plan. The plan
    // carries the lead roles it deliberately leaves alone, and a non-owner's
    // own role sits at exactly their rank — always in that lead, and never
    // touchable under strict outrank — so gating every entry refused every
    // non-owner. normalizeOrder already keeps its rewrites above the floor;
    // this re-checks them through mayTouch, which also carries MANAGE_ROLES.
    const rewrites = plan
      .map((planned, i) => ({ from: next[i].position, to: planned.position }))
      .filter(({ from, to }) => from !== to);
    if (rewrites.length === 0) return null;
    return rewrites.every(({ from, to }) => mayTouch(from) && mayTouch(to)) ? plan : null;
  };

  /** Take the offered escape: give every role its own position, in the order dropped. */
  const applyEvenOut = async () => {
    if (!evenOut) return;
    setEvenOut(null);
    setError(null);
    // Rebuild the requested order from the CURRENT roster. A role revoked or
    // added since the refusal means the order on screen is not the one this
    // plan was for, and re-dragging is the honest recovery.
    const found = evenOut.map((roleId) => roles.find((r) => r.roleId === roleId));
    const next = found.filter((r): r is Role => r !== undefined);
    const plan = next.length === evenOut.length && next.length === roles.length ? planEvenOut(next) : null;
    if (!plan) {
      setError("The roles changed while that was on screen. Drag it again.");
      return;
    }
    const moved = plan
      .map((planned, i) => ({ role: next[i], position: planned.position }))
      .filter(({ role, position }) => role.position !== position);
    if (moved.length === 0) return;
    await applyMoves(moved);
  };

  const onDrop = (to: number) => {
    const from = dragFrom;
    setDragFrom(null);
    if (from === null || from === to) return;
    const next = [...roles];
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    void commitOrder(next);
  };

  /**
   * Revoke a role: strip it from every Grant holding it, then publish a final
   * edition carrying no permissions. It confers nothing and is held by nobody.
   *
   * Deliberately NOT called deletion, in the UI or here. CORD-04 models no role
   * tombstone — CORD-03:31 deletes a Channel with an explicit `"deleted": true`
   * edition, a Role has no equivalent, and `roleToJSON` erases anything we
   * invented. The role stays listed and keeps consuming one of the Community's
   * 100 role slots (CORD-04 §2) forever. A real delete needs a spec change.
   *
   * Grants first, then the Role — CORD-04 §6 ordering: authority is revoked
   * before the entity it hangs off changes.
   */
  const revokeRole = async (role: Role) => {
    setError(null);
    setEvenOut(null);
    const { strippable, skipped, skippedOwner, skippedRank } = holdersOf(role);
    // Like the reorder, a sequence of independent publishes with no rollback.
    let stripped = 0;
    try {
      for (const g of strippable) {
        await setMemberRoles({ member: g.member, roleIds: g.roleIds.filter((r) => r !== role.roleId) });
        stripped++;
      }
      await saveRole({ role: { ...role, permissions: 0n } });
      // Same split as the confirm screen: `canActOnMember` refuses the owner as
      // a target outright, which is not "you don't outrank them" — and reads as
      // nonsense when the owner is the one revoking their own role.
      const stillHold = [
        skippedRank.length > 0
          ? `${skippedRank.length} member${skippedRank.length === 1 ? "" : "s"} you don't outrank`
          : null,
        skippedOwner.length > 0 ? "the owner (never removable)" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      toast({
        title: "Role revoked",
        description: stillHold
          ? `It now confers nothing, but ${stillHold} still ${skipped.length === 1 ? "lists" : "list"} it.`
          : "Taken from every member; it now confers nothing.",
      });
      setConfirmRevoke(null);
    } catch (e) {
      const why = e instanceof Error ? e.message : "Couldn't revoke the role.";
      setError(
        `${why} ${stripped} of ${strippable.length} grants were stripped and the role still carries its permissions. Nothing was undone — revoke again to finish.`,
      );
    }
  };

  if (confirmRevoke) {
    const { strippable, skipped, skippedOwner, skippedRank } = holdersOf(confirmRevoke);
    return (
      <div className="flex flex-col gap-5">
        <div className="space-y-2">
          <h2 className="font-mono text-xl font-bold lowercase tracking-tight">revoke {confirmRevoke.name}?</h2>
          <p className="text-sm text-muted-foreground">
            It will be stripped of every permission
            {strippable.length > 0 &&
              ` and taken from ${strippable.length === 1 ? "1 member" : `${strippable.length} members`}`}
            .
          </p>
          {skippedRank.length > 0 && (
            <p className="text-sm text-muted-foreground">
              You don't outrank <MemberNames members={skippedRank} />, so the role stays listed on{" "}
              {skippedRank.length === 1 ? "their grant" : "their grants"}.
            </p>
          )}
          {skippedOwner.length > 0 && (
            <p className="text-sm text-muted-foreground">
              The owner's grant can never be rewritten by anyone, so the role stays listed on it.
            </p>
          )}
          {skipped.length > 0 && (
            <p className="text-sm text-muted-foreground">
              With no permissions left it confers nothing there either.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            This does not delete it. Concord has no way to remove a role, so the name stays in this list and
            keeps one of the community's {MAX_ROLES_PER_COMMUNITY} role slots for good.
          </p>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            className="flex-1"
            onClick={() => {
              setConfirmRevoke(null);
              setError(null);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="flex-1 clip-corner-lg"
            onClick={() => void revokeRole(confirmRevoke)}
            disabled={busy}
          >
            {busy ? <><Loader2 className="size-4 mr-2 animate-spin" /> Revoking...</> : "Revoke role"}
          </Button>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <RoleEditor
        role={editing}
        channels={channels.map((c) => ({ idHex: c.channelIdHex, name: c.name }))}
        saving={isSavingRole}
        error={error}
        canRevoke={roles.some((r) => r.roleId === editing.roleId) && mayTouch(editing.position)}
        onRevoke={() => {
          setError(null);
          setConfirmRevoke(editing);
          setEditing(null);
        }}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={async (role) => {
          setError(null);
          try {
            await saveRole({ role });
            toast({ title: "Role saved" });
            setEditing(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't save the role.");
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <ArmadaCrest size={64} />
        <h2 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">roles</h2>
        <p className="text-sm text-muted-foreground">
          Roles bundle permissions at a rank. Lower position = higher authority; the owner is position 0 and
          unmintable.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {evenOut && (
              <>
                <span className="mt-2 block">
                  Give every role its own position and this move works. It rewrites the position of roles you
                  did not drag; nothing else about them changes.
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => void applyEvenOut()}
                >
                  {busy ? <><Loader2 className="size-4 mr-2 animate-spin" /> Evening out...</> : "Even out positions and move"}
                </Button>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="w-full space-y-1 rounded-lg bg-secondary/40 p-1">
        {roles.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">No roles yet.</div>
        ) : (
          roles.map((r, i) => {
            const movable = mayTouch(r.position) && !busy;
            const tint = colorToHex(r.color);
            return (
              <div
                key={r.roleId}
                draggable={movable}
                onDragStart={() => setDragFrom(i)}
                onDragEnd={() => setDragFrom(null)}
                onDragOver={(e) => {
                  if (dragFrom !== null) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(i);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 transition-colors hover:bg-secondary/70",
                  dragFrom === i && "opacity-50",
                )}
              >
                <GripVertical
                  className={cn("size-4 shrink-0 text-muted-foreground", movable ? "cursor-grab" : "opacity-30")}
                  aria-hidden
                />
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setEvenOut(null);
                    setEditing(r);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
                >
                  <Shield className="size-4 shrink-0" style={tint ? { color: tint } : undefined} />
                  <span className="flex-1 truncate text-sm font-medium" style={tint ? { color: tint } : undefined}>
                    {r.name}
                  </span>
                  {r.scope.kind === "channel" && (
                    <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                      <Hash className="size-3 shrink-0" aria-hidden />
                      <span className="truncate max-w-24">{channelName(r.scope.channelId)}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>

      {roles.length >= MAX_ROLES_PER_COMMUNITY && (
        <p className="text-xs text-muted-foreground">
          This community holds the maximum of {MAX_ROLES_PER_COMMUNITY} roles (CORD-04 §2). Revoking one does
          not free its slot.
        </p>
      )}
      {/*
        The 100-role cap is read off the fold, so before it lands `roles` is
        empty and the cap reads as 0/100 on a community that may already be
        full. Wait for the fold rather than offering a create we can't check.
      */}
      <Button
        type="button"
        variant="secondary"
        className="w-full clip-corner-lg"
        disabled={!folded || busy || roles.length >= MAX_ROLES_PER_COMMUNITY}
        onClick={() => {
          setError(null);
          setEvenOut(null);
          const lowest = roles.reduce((m, r) => Math.max(m, r.position), 1);
          setEditing({
            roleId: newRoleId(),
            name: "New role",
            position: lowest + 1,
            permissions: 0n,
            scope: { kind: "server" },
            color: 0,
          });
        }}
      >
        <Plus className="size-4 mr-2" /> Create role
      </Button>
    </div>
  );
}

function RoleEditor({
  role,
  channels,
  saving,
  error,
  canRevoke,
  onSave,
  onRevoke,
  onCancel,
}: {
  role: Role;
  channels: Array<{ idHex: string; name: string }>;
  saving: boolean;
  error: string | null;
  canRevoke: boolean;
  onSave: (role: Role) => void;
  onRevoke: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<bigint>(role.permissions);
  const [display, setDisplay] = useState(Boolean(role.display));
  const [color, setColor] = useState<number>(role.color);
  // `0` is the spec's "theme default", so pure black and no-colour are the same
  // wire value and the swatch cannot show the difference. Remember the pick so
  // we can say why the colour appeared not to take.
  const [choseBlack, setChoseBlack] = useState(false);
  // Select value: "server", or the channel id of a channel scope.
  const [scopeValue, setScopeValue] = useState(role.scope.kind === "channel" ? role.scope.channelId : "server");

  const toggle = (bit: bigint, on: boolean) => {
    setPerms((p) => (on ? p | bit : p & ~bit));
  };

  // A role scoped to a since-deleted channel still edits cleanly: keep its
  // channel selectable (as a stub) rather than silently rescoping on save.
  const scopeOptions = useMemo(() => {
    const opts = [...channels];
    const scope = role.scope;
    if (scope.kind === "channel" && !opts.some((c) => c.idHex === scope.channelId)) {
      opts.push({ idHex: scope.channelId, name: "deleted channel" });
    }
    return opts;
  }, [channels, role.scope]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const scope: RoleScope = scopeValue === "server" ? { kind: "server" } : { kind: "channel", channelId: scopeValue };
        onSave({ ...role, name: name.trim() || "Role", permissions: perms, color, scope, display: display || undefined });
      }}
      className="flex flex-col gap-5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="role2-name">Role name</Label>
        <Input id="role2-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
      </div>

      <div className="space-y-1.5">
        <Label>Colour</Label>
        <div className="flex items-center gap-3">
          <ColorPicker
            value={colorToHex(color) ?? DEFAULT_SWATCH}
            onChange={(hex) => {
              setChoseBlack(/^#?0{6}$/.test(hex.trim()));
              setColor(hexToColor(hex));
            }}
            disabled={saving}
          />
          <span className="flex-1 text-xs text-muted-foreground">
            {colorToHex(color)
              ? "Tints the role badge and name."
              : choseBlack
                ? "Pure black is the wire value for \u201Ctheme default\u201D \u2014 pick #010101 for a near-black tint."
                : "Using the theme default."}
          </span>
          {colorToHex(color) && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setColor(0)} disabled={saving}>
              Reset
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role2-scope">Scope</Label>
        <Select value={scopeValue} onValueChange={setScopeValue}>
          <SelectTrigger id="role2-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="server">Entire community</SelectItem>
            {scopeOptions.map((c) => (
              <SelectItem key={c.idHex} value={c.idHex}>
                <span className="inline-flex items-center gap-1">
                  <Hash className="size-3.5 text-muted-foreground" aria-hidden /> {c.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          A channel-scoped role's permissions apply only inside that channel.
        </p>
      </div>

      <label htmlFor="role2-display" className="flex items-start gap-3 cursor-pointer">
        <Checkbox id="role2-display" checked={display} onCheckedChange={(c) => setDisplay(c === true)} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">Display on member list</span>
          <span className="block text-xs text-muted-foreground">Group holders under this role's own name in the member panel.</span>
        </span>
      </label>

      <div className="space-y-2">
        <Label>Permissions</Label>
        <div className="space-y-2 rounded-lg bg-secondary/40 p-3">
          {PERMISSION_LABELS.map(({ bit, label, hint }) => {
            const id = `perm2-${bit.toString()}`;
            const on = (perms & bit) === bit;
            return (
              <label key={id} htmlFor={id} className="flex items-start gap-3 cursor-pointer">
                <Checkbox id={id} checked={on} onCheckedChange={(c) => toggle(bit, c === true)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        {canRevoke && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Revoke role"
            title="Revoke from every member (Concord cannot delete a role)"
            className="text-destructive hover:text-destructive"
            onClick={onRevoke}
            disabled={saving}
          >
            <ShieldOff className="size-4" />
          </Button>
        )}
        <Button type="button" variant="ghost" className="flex-1" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className={cn("flex-1 clip-corner-lg")} disabled={saving}>
          {saving ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving...</> : "Save role"}
        </Button>
      </div>
    </form>
  );
}
