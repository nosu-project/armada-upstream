import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

/** One desired gateway record and the mutation that creates/replaces it. */
export interface DesiredPushRegistration {
  id: string;
  register: () => Promise<void>;
  /**
   * Older ids for this logical watch, deleted right before this PUT when
   * pruning is authoritative (frees quota one item at a time).
   */
  replaces?: readonly string[];
  /** Best-effort rollback when a quota-safe pre-delete is followed by PUT failure. */
  restoreReplaced?: (id: string) => Promise<void>;
  /**
   * Groups records that replace ONE broad predecessor. If quota blocks the
   * 1→many expansion, every child is rolled back to a synthesized broad watch.
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
   * Whether this snapshot may delete registrations it lacks. Incomplete
   * cold-load snapshots are additive-only until every source has read safely.
   */
  allowPrune?: boolean;
  /** Per-plane prune authority for a globally partial snapshot. */
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
 * Rebuild the broad predecessor for a 1→many migration (union of relays and
 * array filter fields), restoring full if over-broad delivery. Scalar fields must agree.
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
 * Reconcile one desired snapshot. Authoritative passes delete each legacy id
 * right before its replacement PUT (works at full quota), rolling back via
 * `restoreReplaced` on failure. Partial snapshots may only pre-delete within
 * authoritative planes. State is persisted after every success; failed
 * deletes stay tracked and are returned for retry.
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

  // Persist before any network call so a crash can't orphan an id.
  options.persistTrackedIds(snapshot());

  // Refresh tracked stable records first (no new quota); groups are handled as one transaction below.
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

  // Release stale ids before PUTs so new ids (e.g. a category change) don't quota-fail first.
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
        // A PUT replaces the WHOLE record, so an unready snapshot must never refresh a
        // tracked id from a partial filter. Only genuinely new ids are additive.
        const trackedTargets = new Set([
          groupDefinition.fallbackId,
          ...(groupDefinition.fallbackIds ?? []),
          ...members.map(({ id }) => id),
        ]);
        if ([...trackedTargets].some((id) => tracked.has(id))) {
          // New relay children are additive; keep the broad predecessor until an authoritative pass.
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
          // At exact quota the fallback can't take a slot; other records can still refresh.
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
        // Collapse every child (including leftovers) to guarantee a slot for the broad
        // fallback. DELETE even rejected PUTs: the server may have committed them.
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
          // Keep refreshing later records; the failure is still reported afterwards.
          unrecoveredErrors.push(restoreError ?? groupFailure);
          // Removed predecessors truthfully stay absent from durable state.
          for (const oldId of removedPredecessors) tracked.delete(oldId);
        }
      }
      continue;
    }

    if (refreshedDesired.has(item.id)) continue;

    const itemAuthoritative = canPrune(item.id);
    // Without authority, a re-PUT might narrow the last-good payload; wait for the plane.
    if (!itemAuthoritative && tracked.has(item.id)) continue;
    const replacements = !itemAuthoritative
      ? []
      : [...new Set(item.replaces ?? [])]
        .filter((oldId) => oldId !== item.id && tracked.has(oldId));
    const removed: string[] = [];

    // Delete the legacy record first: new-first can't progress at exact-full quota.
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
        // The old record is still the best copy; don't risk further deletes.
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
      // Restore the known-good legacy watch; keep durable state truthful if rollback fails.
      if (item.restoreReplaced) {
        for (const oldId of removed) {
          try {
            await item.restoreReplaced(oldId);
            registeredAny = true;
            tracked.add(oldId);
            options.persistTrackedIds(snapshot());
          } catch { /* ignore */ }
        }
      }
      throw error;
    }
  }

  // A newer snapshot is queued; this stale generation must not prune.
  if (!isCurrent()) {
    return { completed: false, trackedIds: snapshot(), failedDeletions: [] };
  }

  // Partial snapshots are additive: persist successes, leave cleanup for an authoritative pass.
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
      // Keep failed deletes tracked, or transient outages leave permanent stale records.
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
 * Serializes mutations; each queued value is a new generation. Superseded
 * queued work is skipped; running work checks `isCurrent` between RPCs.
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

  /** Queue work that must run even if superseded (logout/disable), superseding in-flight work first. */
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
