/**
 * Whether a message was sent while this membership existed. `joinedAtMs` is the
 * vault entry's `added_at`; nothing from before it may mention or notify — the
 * viewer wasn't there. Compared at whole seconds, since `created_at` is one and a
 * message sent in the join's own second must still count. Unknown start admits all.
 */
export function sentDuringMembership(sentAtMs: number, joinedAtMs: number | undefined): boolean {
  return joinedAtMs === undefined || sentAtMs >= Math.floor(joinedAtMs / 1000) * 1000;
}
