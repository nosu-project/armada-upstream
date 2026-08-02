import { ArrowDown, ArrowUp, Hash, Loader2, Plus, Shield } from "lucide-react";
import { useMemo, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRoles2 } from "@/concord-v2/hooks/useRoles2";
import { toast } from "@/hooks/useToast";
import { byDisplayOrder, canActOnPosition, PERMISSION_LABELS, Permissions, type Role, type RoleScope } from "@/concord-v2/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { cn } from "@/lib/utils";

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
  const { folded, saveRole, isSavingRole, newRoleId } = useRoles2(community);
  const { user } = useCurrentUser();
  const [editing, setEditing] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

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
  // Same gate the fold applies when judging a Role edition: publishing a move
  // the network would drop should fail HERE with a readable message instead.
  const canPlaceAt = (position: number) =>
    Boolean(
      user &&
      (user.pubkey === ownerHex ||
        (folded && canActOnPosition(folded.roster, user.pubkey, ownerHex, position, Permissions.MANAGE_ROLES))),
    );

  /**
   * Reorder = re-rank: swap the two roles' authority positions (lower is
   * higher, CORD-04 §3). Peers at the SAME position (tie, display-ordered by
   * role id) can't meaningfully swap — the one moving down is nudged a rank
   * below instead.
   */
  const move = async (index: number, dir: -1 | 1) => {
    const target = roles[index];
    const neighbor = roles[index + dir];
    if (!target || !neighbor || reordering || isSavingRole) return;
    const updates: Role[] = [];
    if (target.position === neighbor.position) {
      const demoted = dir === -1 ? neighbor : target;
      updates.push({ ...demoted, position: demoted.position + 1 });
    } else {
      updates.push({ ...target, position: neighbor.position });
      updates.push({ ...neighbor, position: target.position });
    }
    for (const r of updates) {
      if (!canPlaceAt(r.position)) {
        setError(
          r.position === 1
            ? "Only the owner can place a role at the top rank."
            : "You can't move a role to a rank you don't outrank.",
        );
        return;
      }
    }
    setError(null);
    setReordering(true);
    try {
      for (const r of updates) await saveRole({ role: r });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reorder the roles.");
    } finally {
      setReordering(false);
    }
  };

  if (editing) {
    return (
      <RoleEditor
        role={editing}
        channels={channels.map((c) => ({ idHex: c.channelIdHex, name: c.name }))}
        saving={isSavingRole}
        error={error}
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

      <div className="w-full space-y-1 rounded-lg bg-secondary/40 p-1">
        {roles.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">No roles yet.</div>
        ) : (
          roles.map((r, i) => (
            <div
              key={r.roleId}
              className="group/role flex w-full items-center gap-1 rounded-md pr-1 transition-colors hover:bg-secondary/70"
            >
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left"
              >
                <Shield className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-sm font-medium">{r.name}</span>
                {r.scope.kind === "channel" && (
                  <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                    <Hash className="size-3 shrink-0" aria-hidden />
                    <span className="truncate max-w-24">{channelName(r.scope.channelId)}</span>
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">pos {r.position}</span>
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 touch:size-9 shrink-0 text-muted-foreground opacity-0 group-hover/role:opacity-100 touch:opacity-100 focus-visible:opacity-100 disabled:opacity-0"
                aria-label={`Move ${r.name} up`}
                disabled={i === 0 || reordering}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 touch:size-9 shrink-0 text-muted-foreground opacity-0 group-hover/role:opacity-100 touch:opacity-100 focus-visible:opacity-100 disabled:opacity-0"
                aria-label={`Move ${r.name} down`}
                disabled={i === roles.length - 1 || reordering}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        type="button"
        variant="secondary"
        className="w-full clip-corner-lg"
        onClick={() => {
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
  onSave,
  onCancel,
}: {
  role: Role;
  channels: Array<{ idHex: string; name: string }>;
  saving: boolean;
  error: string | null;
  onSave: (role: Role) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<bigint>(role.permissions);
  const [display, setDisplay] = useState(Boolean(role.display));
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
        onSave({ ...role, name: name.trim() || "Role", permissions: perms, scope, display: display || undefined });
      }}
      className="flex flex-col gap-5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="role2-name">Role name</Label>
        <Input id="role2-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
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
