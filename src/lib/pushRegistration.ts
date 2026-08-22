import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

/** One desired gateway record and the mutation that creates/replaces it. */
export interface DesiredPushRegistration {
  id: string;
  register: () => Promise<void>;
  /**
   * Older ids for this same logical watch. When pruning is authoritative they
   * are removed immediately before this PUT, releasing gateway quota one item
   * at a time during an id migration.
   */
  replaces?: readonly string[];
  /** Best-effort rollback when a quota-safe pre-delete is followed by PUT failure. */
  restoreReplaced?: (id: string) => Promise<void>;
  /**
   * Several desired records may replace ONE broad predecessor. The gateway's
   * quota can make that 1→many expansion impossible even after deleting the
   * predecessor. Grouping lets reconciliation roll every child back and
   * restore one synthesized broad watch, then continue refreshing unrelated
   * desired records on the current endpoint.
   */
  replacementGroup?: {
    key: string;
    fallbackId: string;
    /** Known broad ids, ordered by preferred in-place partial refresh target. */
    fallbackIds?: readonly string[];
    restoreFallback: (id: string) => Promise<void>;
  };
}

export interface ReconcilePushRegistrationsOptions {
  desired: readonly DesiredPushRegistration[];
  /** Durable ids previously registered (including a pending legacy migration). */
  trackedIds: readonly string[];
  deleteRegistration: (id: string) => Promise<void>;
  /** Persist after every successful mutation, so a crash cannot orphan it. */
  persistTrackedIds: (ids: string[]) => void;
  /** Latest-generation guard supplied by {@link LatestSerialRunner}. */
  isCurrent?: () => boolean;
  /**
   * Whether this snapshot is authoritative enough to delete registrations it
   * does not contain. An incomplete cold-load snapshot may still add every
   * record it currently knows about, but it must preserve the durable prune
   * set until all watch sources have completed a safe wire read.
   */
  allowPrune?: boolean;
  /**
   * Optional per-plane authority for a globally partial snapshot. Scoped ids
   * in an authoritative plane may still be removed/replaced; every other id
   * remains additive-only until its own source settles.
   */
  canPruneId?: (id: string) => boolean;
}

export interface ReconcilePushRegistrationsResult {
  /** False when a newer snapshot superseded this pass. */
  completed: boolean;
  /** Current durable prune set. Failed deletions deliberately remain here. */
  trackedIds: string[];
  /** Deletes to retry. Registration failures reject instead. */
  failedDeletions: string[];
  /** At least one PUT refreshed/created a record on the current endpoint. */
  registeredAny?: true;
  /** Additive records that could not fit/reach the gateway in a partial pass. */
  deferredRegistrations?: string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Rebuild the broad logical predecessor for a 1→many filter migration.
 *
 * Relay-scoped NIP-29 children deliberately cannot coexist at a full gateway
 * quota. Their rollback is the former flat watch: union relays and every array
 * filter dimension, which restores complete (if over-broad) delivery until a
 * later migration has enough capacity. Scalar filter fields must agree.
 */
export function mergePushReplacementSpec(
  id: string,
  children: readonly PushSubscriptionSpec[],
): PushSubscriptionSpec {
  const first = children[0];
  if (!first) throw new Error(`Cannot build empty push replacement ${id}`);
  const filter: Record<string, unknown> = {};
  const keys = new Set(children.flatMap((child) => Object.keys(child.filter)));
  for (const key of keys) {
    const values = children
      .map((child) => (child.filter as Record<string, unknown>)[key])
      .filter((value) => value !== undefined);
    if (values.every(Array.isArray)) {
      const merged = [...new Set(values.flat() as Array<string | number>)]
        .sort((a, b) => String(a).localeCompare(String(b)));
      filter[key] = merged;
      continue;
    }
    const encoded = values.map((value) => JSON.stringify(value));
    if (encoded.some((value) => value !== encoded[0])) {
      throw new Error(`Incompatible ${key} in push replacement ${id}`);
    }
    filter[key] = values[0];
  }
  const relays = sorted(children.flatMap(({ relays }) => relays));
  return {
    id,
    relays,
    filter,
    notification: {
      ...first.notification,
      data: { ...first.notification.data, relays },
    },
  } as PushSubscriptionSpec;
}

/**
 * Reconcile one desired snapshot while preserving a recoverable watch set.
 *
 * The ordering is load-bearing for web's per-install id migration. An
 * authoritative pass removes each matching legacy id immediately before its
 * replacement PUT, releasing a quota slot even when the gateway is already
 * full. If that PUT fails, `restoreReplaced` makes a best-effort rollback of
 * the bounded delivery gap. A globally partial snapshot may pre-delete only
 * inside a plane its own sources have made authoritative. State is persisted
 * after every success; a failed delete stays durable and is returned to the
 * caller for retry.
 */
export async function reconcilePushRegistrations(
  options: ReconcilePushRegistrationsOptions,
): Promise<ReconcilePushRegistrationsResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  const tracked = new Set(options.trackedIds);
  const snapshot = () => sorted(tracked);
  const attemptedDeletes = new Set<string>();
  const failedDeletions: string[] = [];
  const retainedFallbacks = new Set<string>();
  const processedGroups = new Set<string>();
  const refreshedDesired = new Set<string>();
  const unrecoveredErrors: unknown[] = [];
  const deferredRegistrations: string[] = [];
  let registeredAny = false;
  const canPrune = (id: string) => options.allowPrune !== false
    || options.canPruneId?.(id) === true;

  const grouped = new Map<string, DesiredPushRegistration[]>();
  for (const item of options.desired) {
    const key = item.replacementGroup?.key;
    if (!key) continue;
    const members = grouped.get(key) ?? [];
    members.push(item);
    grouped.set(key, members);
  }

  // Transfer a legacy flat registry into the scoped registry before the first
  // network call. A crash after a successful RPC can then never orphan an id.
  options.persistTrackedIds(snapshot());

  // Refresh already-tracked stable records first. They consume no new quota
  // and this ensures the current endpoint reaches DM/Concord even if a later
  // id migration must fall back or defer. Group members are handled as one
  // transaction below so they cannot be refreshed independently.
  if (options.allowPrune !== false || options.canPruneId) {
    for (const item of options.desired) {
      if (item.replacementGroup || !tracked.has(item.id) || !canPrune(item.id)) continue;
      if (!isCurrent()) {
        return { completed: false, trackedIds: snapshot(), failedDeletions };
      }
      await item.register();
      registeredAny = true;
      refreshedDesired.add(item.id);
      options.persistTrackedIds(snapshot());
    }
  }

  // On every authoritative snapshot, release unrelated stale ids before PUTs.
  // Besides reserving capacity for G→G-A/B, this covers a one-relay category
  // transition (all→mentions): its old relay-scoped id is stale, and waiting
  // until the final prune would make the new id quota-fail first.
  if (options.allowPrune !== false || options.canPruneId) {
    const desiredIds = new Set(options.desired.map(({ id }) => id));
    const predecessorIds = new Set(
      options.desired.flatMap(({ replaces }) => [...(replaces ?? [])]),
    );
    for (const id of snapshot()) {
      if (desiredIds.has(id) || predecessorIds.has(id) || !canPrune(id)) continue;
      if (!isCurrent()) {
        return { completed: false, trackedIds: snapshot(), failedDeletions };
      }
      attemptedDeletes.add(id);
      try {
        await options.deleteRegistration(id);
        tracked.delete(id);
        options.persistTrackedIds(snapshot());
      } catch {
        failedDeletions.push(id);
      }
    }
  }

  desired: for (const item of options.desired) {
    if (!isCurrent()) {
      return { completed: false, trackedIds: snapshot(), failedDeletions: [] };
    }

    const groupDefinition = item.replacementGroup;
    if (groupDefinition) {
      if (processedGroups.has(groupDefinition.key)) continue;
      processedGroups.add(groupDefinition.key);
      const members = grouped.get(groupDefinition.key) ?? [item];
      const predecessorIds = [...new Set(
        members.flatMap(({ replaces }) => [...(replaces ?? [])]),
      )].filter((oldId) => !members.some(({ id }) => id === oldId));

      const groupAuthoritative = members.every(({ id }) => canPrune(id));
      if (!groupAuthoritative) {
        // A NIP-PUSH PUT replaces the WHOLE record, so an unready snapshot must
        // never refresh a tracked broad/child id from its partial filter (A
        // would silently replace last-good A+B). Preserve every held record
        // byte-for-byte. Only a genuinely new fallback id is additive.
        const trackedTargets = new Set([
          groupDefinition.fallbackId,
          ...(groupDefinition.fallbackIds ?? []),
          ...members.map(({ id }) => id),
        ]);
        if ([...trackedTargets].some((id) => tracked.has(id))) {
          // Existing records stay byte-for-byte intact, but a newly discovered
          // relay child is genuinely additive. Register each missing child on
          // its own; keep any broad predecessor until an authoritative pass
          // can safely remove it.
          for (const member of members) {
            if (tracked.has(member.id)) continue;
            if (!isCurrent()) {
              return { completed: false, trackedIds: snapshot(), failedDeletions };
            }
            try {
              await member.register();
              registeredAny = true;
              tracked.add(member.id);
              options.persistTrackedIds(snapshot());
            } catch {
              deferredRegistrations.push(member.id);
            }
          }
          continue;
        }
        try {
          await groupDefinition.restoreFallback(groupDefinition.fallbackId);
          registeredAny = true;
          tracked.add(groupDefinition.fallbackId);
          options.persistTrackedIds(snapshot());
        } catch {
          // At exact quota the new synthesized fallback cannot take a slot,
          // but independent ready-plane records can still refresh/activate.
          deferredRegistrations.push(
            groupDefinition.fallbackId,
            ...members.map(({ id }) => id),
          );
        }
        continue;
      }

      const removedPredecessors: string[] = [];
      let predecessorDeleteFailed = false;

      for (const oldId of predecessorIds) {
        if (!tracked.has(oldId)) continue;
        if (!isCurrent()) {
          return { completed: false, trackedIds: snapshot(), failedDeletions };
        }
        attemptedDeletes.add(oldId);
        try {
          await options.deleteRegistration(oldId);
          tracked.delete(oldId);
          removedPredecessors.push(oldId);
          options.persistTrackedIds(snapshot());
        } catch {
          failedDeletions.push(oldId);
          predecessorDeleteFailed = true;
          break;
        }
      }

      let groupFailure: unknown;
      if (!predecessorDeleteFailed) {
        for (const member of members) {
          if (!isCurrent()) {
            return { completed: false, trackedIds: snapshot(), failedDeletions };
          }
          try {
            await member.register();
            registeredAny = true;
            tracked.add(member.id);
            options.persistTrackedIds(snapshot());
          } catch (error) {
            groupFailure = error;
            break;
          }
        }
      }

      if (predecessorDeleteFailed || groupFailure !== undefined) {
        // Collapse every child, including one left by an older interrupted
        // attempt. This guarantees a slot for the single broad fallback and
        // prevents a permanently deterministic "only relay A" result. DELETE
        // even the child whose PUT rejected: the server may have committed it
        // before the response was lost, so treating that id as absent would
        // create an untracked orphan.
        for (const member of members) {
          if (!isCurrent()) {
            return { completed: false, trackedIds: snapshot(), failedDeletions };
          }
          attemptedDeletes.add(member.id);
          try {
            await options.deleteRegistration(member.id);
            tracked.delete(member.id);
            options.persistTrackedIds(snapshot());
          } catch {
            tracked.add(member.id);
            options.persistTrackedIds(snapshot());
            failedDeletions.push(member.id);
          }
        }

        if (!isCurrent()) {
          return { completed: false, trackedIds: snapshot(), failedDeletions };
        }
        try {
          await groupDefinition.restoreFallback(groupDefinition.fallbackId);
          registeredAny = true;
          tracked.add(groupDefinition.fallbackId);
          retainedFallbacks.add(groupDefinition.fallbackId);
          options.persistTrackedIds(snapshot());
        } catch (restoreError) {
          // Continue through later stable records so their endpoint/payload is
          // refreshed even when this migration cannot be recovered. The
          // caller still receives a failure after that useful work finishes.
          unrecoveredErrors.push(restoreError ?? groupFailure);
          // Removed predecessors truthfully stay absent from durable state.
          for (const oldId of removedPredecessors) tracked.delete(oldId);
        }
      }
      continue;
    }

    if (refreshedDesired.has(item.id)) continue;

    const itemAuthoritative = canPrune(item.id);
    // Re-PUT is replacement, not addition. Without authority we do not know
    // whether this currently-derived filter is narrower than the tracked
    // record's last-good payload, so preserve it and wait for that plane.
    if (!itemAuthoritative && tracked.has(item.id)) continue;
    const replacements = !itemAuthoritative
      ? []
      : [...new Set(item.replaces ?? [])]
        .filter((oldId) => oldId !== item.id && tracked.has(oldId));
    const removed: string[] = [];

    // Delete the known equivalent legacy record first. A new-first migration
    // cannot make progress at an exact-full gateway quota: its first PUT is
    // refused, so it never reaches the delete that would free capacity.
    for (const oldId of replacements) {
      if (!isCurrent()) {
        return { completed: false, trackedIds: snapshot(), failedDeletions };
      }
      attemptedDeletes.add(oldId);
      try {
        await options.deleteRegistration(oldId);
        tracked.delete(oldId);
        removed.push(oldId);
        options.persistTrackedIds(snapshot());
      } catch {
        failedDeletions.push(oldId);
        // This old record is still the best available copy of the logical
        // watch. Do not risk a quota-failing PUT or remove more equivalents.
        continue desired;
      }
    }

    try {
      await item.register();
      registeredAny = true;
      tracked.add(item.id);
      options.persistTrackedIds(snapshot());
    } catch (error) {
      if (!itemAuthoritative) {
        deferredRegistrations.push(item.id);
        continue desired;
      }
      // The matching legacy watch was known-good before its successful DELETE.
      // Restore it with the current endpoint/payload where possible, while
      // preserving truthful durable state if rollback itself fails.
      if (item.restoreReplaced) {
        for (const oldId of removed) {
          try {
            await item.restoreReplaced(oldId);
            registeredAny = true;
            tracked.add(oldId);
            options.persistTrackedIds(snapshot());
          } catch {
            // Its DELETE succeeded and rollback did not; leaving it absent from
            // the prune set accurately records that no server record is known.
          }
        }
      }
      throw error;
    }
  }

  // A newer snapshot may have arrived while the final PUT was in flight. It
  // will run next; the stale generation must not choose what to delete.
  if (!isCurrent()) {
    return { completed: false, trackedIds: snapshot(), failedDeletions: [] };
  }

  // A globally partial snapshot is additive in every unready plane. Persist
  // successful PUTs (and any selective ready-plane removals) so a crash cannot
  // orphan them, while leaving all other cleanup for a later authoritative pass.
  if (options.allowPrune === false) {
    const trackedIds = snapshot();
    options.persistTrackedIds(trackedIds);
    if (unrecoveredErrors.length > 0) throw unrecoveredErrors[0];
    return {
      completed: true,
      trackedIds,
      failedDeletions,
      ...(registeredAny ? { registeredAny: true as const } : {}),
      ...(deferredRegistrations.length > 0
        ? { deferredRegistrations: sorted(deferredRegistrations) }
        : {}),
    };
  }

  const desiredIds = new Set(options.desired.map(({ id }) => id));
  for (const id of snapshot()) {
    if (desiredIds.has(id) || retainedFallbacks.has(id) || attemptedDeletes.has(id)) continue;
    if (!isCurrent()) {
      return { completed: false, trackedIds: snapshot(), failedDeletions };
    }
    try {
      await options.deleteRegistration(id);
      tracked.delete(id);
      options.persistTrackedIds(snapshot());
    } catch {
      // Keep it tracked. Forgetting a failed delete is how stale gateway
      // records become permanent after a transient outage.
      failedDeletions.push(id);
    }
  }

  const trackedIds = snapshot();
  options.persistTrackedIds(trackedIds);
  if (unrecoveredErrors.length > 0) throw unrecoveredErrors[0];
  return {
    completed: isCurrent(),
    trackedIds,
    failedDeletions,
    ...(registeredAny ? { registeredAny: true as const } : {}),
  };
}

/**
 * Serializes mutations and makes each queued value a new generation.
 *
 * A queued generation that has not started is skipped when superseded. A
 * running worker receives `isCurrent`; reconciliation checks it between RPCs
 * and before pruning, then the newest snapshot runs on the same serial tail.
 */
export class LatestSerialRunner<T, R> {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: (value: T, isCurrent: () => boolean) => Promise<R>,
  ) {}

  run(value: T): Promise<R | undefined> {
    const generation = ++this.generation;
    const work = this.tail.then(async () => {
      if (generation !== this.generation) return undefined;
      return this.worker(value, () => generation === this.generation);
    });
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  /**
   * Queue work that must run even if a newer latest-value arrives (logout and
   * explicit disable use this to remove the old account before a new one can
   * register). It first supersedes any in-flight latest snapshot.
   */
  runExclusive(value: T): Promise<R> {
    this.generation += 1;
    const work = this.tail.then(() => this.worker(value, () => true));
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  /** Supersede queued/running work without scheduling another generation. */
  invalidate(): void {
    this.generation += 1;
  }
}
