import { useCallback, useEffect, useRef, useState } from "react";

/** What a role toggle publishes: the member's complete new role set. */
export type PublishRoles = (args: { member: string; roleIds: string[] }) => Promise<unknown>;

const keyOf = (member: string, roleId: string) => `${member}:${roleId}`;

/**
 * Sequencing for per-member role toggles.
 *
 * A Grant edition replaces a member's WHOLE role list (CORD-04 §2), so every
 * toggle has to send the complete set — and the only published copy of that
 * set is the control fold, which lags its own publish by a refetch. Reading
 * the base from the fold means two quick toggles both start from the same
 * stale list and the second silently drops the first's role.
 *
 * So intent is tracked locally: each toggle composes on the last set THIS
 * client asked for, and the overlay is dropped as soon as the fold agrees with
 * it, which is what lets a change made elsewhere take over again rather than
 * being permanently masked. A repeat toggle of the same member+role while one
 * is in flight is ignored — it would publish twice and, for a gated channel,
 * start two key rotations.
 */
export function useRoleIntent(
  memberRoleIds: Record<string, string[] | undefined>,
  publish: PublishRoles,
) {
  // Intent is read and written inside one synchronous toggle, so it must not
  // wait for a render to be visible — hence a ref, mirrored into state only
  // for the pending flags the UI disables on.
  const intent = useRef(new Map<string, string[]>());
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const syncPending = useCallback(() => setPending(new Set(inFlight.current)), []);

  // Retire an overlay the moment the fold agrees with it — checked on every
  // fold change, not lazily on the next toggle, because the agreement can come
  // and go: the fold catches up, then someone else edits the same member. A
  // lazy check would miss the match and mask their change with our stale copy.
  useEffect(() => {
    for (const [member, local] of intent.current) {
      const folded = memberRoleIds[member] ?? [];
      if (local.length === folded.length && local.every((id) => folded.includes(id))) {
        intent.current.delete(member);
      }
    }
  }, [memberRoleIds]);

  const baseFor = useCallback(
    (member: string): string[] => intent.current.get(member) ?? memberRoleIds[member] ?? [],
    [memberRoleIds],
  );

  const toggle = useCallback(
    async (member: string, roleId: string, on: boolean): Promise<string[] | undefined> => {
      const k = keyOf(member, roleId);
      if (inFlight.current.has(k)) return undefined;

      const base = baseFor(member);
      const next = new Set(base);
      if (on) next.add(roleId);
      else next.delete(roleId);
      const roleIds = [...next];

      // What to fall back to if this publish fails. Deleting the overlay
      // outright would drop an EARLIER toggle that did land, leaving the base
      // to fall through to a fold that still lags it — so the next toggle
      // would compose on a set missing that role and silently revoke it,
      // which is the bug this hook exists to prevent.
      const hadIntent = intent.current.has(member);

      intent.current.set(member, roleIds);
      inFlight.current.add(k);
      syncPending();
      try {
        await publish({ member, roleIds });
        return roleIds;
      } catch (e) {
        // Nothing landed, so THIS toggle's intent is a lie — roll back to the
        // set that was true before it, not to the lagging fold.
        if (hadIntent) intent.current.set(member, base);
        else intent.current.delete(member);
        throw e;
      } finally {
        inFlight.current.delete(k);
        syncPending();
      }
    },
    [baseFor, publish, syncPending],
  );

  const isPending = useCallback((member: string, roleId: string) => pending.has(keyOf(member, roleId)), [pending]);

  /** The set a row should render as checked: local intent, else the fold. */
  const rolesFor = useCallback((member: string) => intent.current.get(member) ?? memberRoleIds[member] ?? [], [memberRoleIds]);

  return { toggle, isPending, rolesFor };
}
