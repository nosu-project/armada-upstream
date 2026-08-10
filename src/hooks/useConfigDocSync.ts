import { useCallback, useEffect, useReducer, useRef } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";
import { resolveLegacy } from "@/lib/settingsDocs";
import { configSnapshot, docToConfigPatch, type ConfigDocName } from "@/lib/syncedConfig";

import type { AppConfig } from "@/contexts/AppContext";

/** Debounce for pushing local config changes to a NIP-78 settings document. */
const PUBLISH_DEBOUNCE_MS = 800;
/** Retry a durable local settings edit whose relay delivery failed. */
const PUBLISH_RETRY_MS = 5_000;

/**
 * Publish baselines of the mounted {@link useConfigDocSync} instances, keyed
 * by document.
 *
 * A config change is published because it differs from the baseline, which
 * means "what the remote document already says". Some config changes aren't
 * user edits at all: hydrating the user's canonical kind-10002/10050/10063
 * lists updates their local mirrors, and must not be broadcast as though the
 * user edited an Armada preference. {@link markConfigSynced} lets those
 * hydrating effects move the baselines with them.
 *
 * Module-scoped because the effects that do the hydrating (in NostrSync) are
 * siblings of these hooks, not children — there is nothing to pass a ref
 * through. Instances deregister on unmount, so this holds only live ones.
 */
const publishBaselines = new Map<ConfigDocName, (config: AppConfig) => void>();

/**
 * Record `config` as already-synced, so the next diff doesn't treat it as a
 * user edit. A no-op for a document whose baseline hasn't been established
 * yet: it will adopt whatever it first observes anyway.
 */
export function markConfigSynced(config: AppConfig): void {
  for (const bump of publishBaselines.values()) bump(config);
}

/**
 * Keep one AppConfig slice and its encrypted NIP-78 document in sync, both
 * ways. Instantiated once per document that mirrors config — metadata, rail,
 * notifications, dms (see `lib/syncedConfig.ts`).
 *
 * One instance per document rather than one for all of them is the whole point
 * of the split: each carries its OWN applied-id guard, publish baseline and
 * debounce timer, so a rail drag diffs and republishes two dozen bytes of
 * layout instead of every preference the user has, and a notification-level
 * change can't lose a race with it.
 *
 * IN (document → config). Apply each version once, identified by the event it
 * came in. Which version that is has already been decided — by the store,
 * which keeps only the newest version of the NIP-01 coordinate — so there is
 * no timestamp arbitration to do here. A stale copy arriving late from a slow
 * relay is refused by the store and never reaches this hook. (The exception is
 * the legacy metadata document, where there genuinely are two coordinates in
 * play; `resolveLegacy` owns that comparison.)
 *
 * OUT (config → document). A DIRECT user config edit is pushed back so it
 * syncs across devices. This is the ONLY place Armada broadcasts a settings
 * event automatically, and it must fire only for a real user mutation — never
 * off boot-time or sync-driven config changes, which keep `lastPublished` in
 * lockstep so the diff can only reflect a user edit.
 */
export function useConfigDocSync(name: ConfigDocName): void {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const { doc, event, update, hasNip44Support } = useSettingsDoc(name);
  const metadata = useSettingsDoc("metadata");
  const configRef = useRef(config);
  configRef.current = config;
  const [, recheckAfterPublish] = useReducer((value: number) => value + 1, 0);

  // The version we've most recently folded into local config.
  const appliedId = useRef<string | undefined>(undefined);
  // Its created_at, so the apply effect can refuse a version OLDER than one it
  // already applied. The store never regresses, but the query cache between
  // the store and this hook can: a refetch that read the store before a write
  // landed can resolve after it and put the previous version back in the
  // cache. Applying that would revert the user's newest edit — and set
  // `lastPublished` to the old layout, so the publish watcher would never
  // re-publish the lost one.
  const appliedCreatedAt = useRef<number | undefined>(undefined);
  // Serialized slice last known to match the remote document, so the publish
  // watcher can skip no-op writes (including the config change caused by
  // applying an incoming pull).
  const lastPublished = useRef<string | undefined>(undefined);
  // A pending debounced publish. Non-null means "a local edit is newer than
  // anything on disk", which the apply effect reads to know not to write over
  // it — so clearing the timeout must also clear the ref, or a cancelled
  // publish would look like a permanently in-flight one.
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Publishes past their debounce but not yet settled. The timer ref alone
  // left a hole: it was cleared at fire time, while the write itself — a store
  // read plus two signer round-trips, seconds on a NIP-46 signer — was still
  // in flight, and during that window the apply effect would happily fold a
  // stale cache version over the edit being written. Counted, not boolean:
  // never reset, because every increment has exactly one decrement in
  // `finally`, and zeroing it on account switch would unbalance a write that
  // settles after the switch — stale completions are instead ignored via
  // `accountGeneration`.
  const publishesInFlight = useRef(0);
  const accountGeneration = useRef(0);
  const cancelPublish = useCallback(() => {
    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = null;
  }, []);

  useEffect(() => {
    accountGeneration.current += 1;
    appliedId.current = undefined;
    appliedCreatedAt.current = undefined;
    lastPublished.current = undefined;
    // A debounced publish belongs to the account that made the edit; letting
    // one fire after a switch would write that config into the new account's
    // settings document. An already-signed request in flight cannot be
    // cancelled here; the generation check in `attempt` ignores its
    // completion instead.
    cancelPublish();
  }, [user?.pubkey, cancelPublish]);

  useEffect(() => {
    if (automaticSettingsSync) return;
    // Stop every future automatic action on this installation. A request that
    // has already reached the signer/network cannot be recalled, but changing
    // the generation prevents its completion from scheduling another write.
    // (`publishesInFlight` is deliberately left to drain on its own.)
    accountGeneration.current += 1;
    cancelPublish();
  }, [automaticSettingsSync, cancelPublish]);

  // Let a sync-driven config change (see `markConfigSynced`) move this
  // document's baseline instead of looking like a user edit.
  useEffect(() => {
    publishBaselines.set(name, (synced) => {
      if (lastPublished.current === undefined) return;
      lastPublished.current = JSON.stringify(configSnapshot(synced, name));
    });
    return () => {
      publishBaselines.delete(name);
    };
  }, [name]);

  // ─── Document → config ────────────────────────────────────────────────
  const split = doc && event ? { doc, event } : null;
  const legacy = metadata.doc && metadata.event
    ? { doc: metadata.doc, event: metadata.event }
    : null;
  const resolved = name === "metadata" ? split : resolveLegacy(name, split, legacy);

  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey || !resolved) return;
    if (appliedId.current === resolved.event.id) return;

    // …with one exception: a local edit inside its publish debounce, or whose
    // publish is still being written, is newer than anything on disk and isn't
    // on disk yet. Applying over it would revert what the user just did, and
    // the publish watcher would then see no diff and never publish it. The
    // publish itself supersedes this version, so skipping is not a deferral —
    // there is nothing left to apply, and the publish landing re-renders this
    // hook with its own (newer) event anyway.
    if (publishTimer.current || publishesInFlight.current > 0) return;

    // Never fold a version older than one already applied. Only a cache
    // regression can present one (see `appliedCreatedAt`); the newest version
    // is already in config.
    if (appliedCreatedAt.current !== undefined
      && resolved.event.created_at < appliedCreatedAt.current) return;

    appliedId.current = resolved.event.id;
    appliedCreatedAt.current = resolved.event.created_at;
    const patch = docToConfigPatch(name, resolved.doc as Record<string, unknown>);

    updateConfig((current: AppConfig) => {
      const next = { ...current, ...patch };
      // Record what we just applied so the publish watcher treats it as
      // already-synced and doesn't echo it straight back out.
      lastPublished.current = JSON.stringify(configSnapshot(next, name));
      return next;
    });
  }, [automaticSettingsSync, user?.pubkey, name, resolved, updateConfig]);

  // ─── Config → document ────────────────────────────────────────────────
  //
  // `metadata.doc === null` means the store holds no metadata document, i.e.
  // this user has no Armada settings at all. Publishing then would merge the
  // local slice over `{}` and REPLACE the user's real settings on every device
  // with it — so we don't, and a user who genuinely has none simply runs on
  // app defaults until they create some explicitly. The METADATA document is
  // the signal for every slice: a split document is legitimately absent until
  // its domain is first touched, so its own null says nothing.
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey || !hasNip44Support || metadata.doc === null) {
      return;
    }

    const snapshot = JSON.stringify(configSnapshot(config, name));
    if (lastPublished.current === undefined) {
      // First observation: adopt current state as the baseline (matches what
      // the apply effect wrote, or the local defaults if it hasn't run).
      lastPublished.current = snapshot;
      return;
    }
    if (snapshot === lastPublished.current) return;
    if (publishesInFlight.current > 0) return;

    cancelPublish();
    const attempt = () => {
      publishTimer.current = null;
      publishesInFlight.current += 1;
      const generation = accountGeneration.current;
      const attemptSnapshot = JSON.stringify(configSnapshot(configRef.current, name));
      const patch = configSnapshot(configRef.current, name);
      let succeeded = false;
      update(patch)
        .then(() => {
          if (accountGeneration.current !== generation) return;
          lastPublished.current = attemptSnapshot;
          succeeded = true;
        })
        .catch((err) => {
          if (accountGeneration.current !== generation) return;
          console.warn(`Config sync failed for ${name}; retrying:`, err);
          publishTimer.current = setTimeout(attempt, PUBLISH_RETRY_MS);
        })
        .finally(() => {
          // Decrement unconditionally to keep the counter balanced; only the
          // side effects below belong to the account that scheduled the write.
          publishesInFlight.current -= 1;
          if (accountGeneration.current !== generation) return;
          // The config (or an incoming relay version) may have changed while
          // delivery was in flight. Re-run both directions now that the gate
          // is open so that latest state cannot wait for an unrelated edit.
          if (succeeded) recheckAfterPublish();
        });
    };
    publishTimer.current = setTimeout(attempt, PUBLISH_DEBOUNCE_MS);

    return cancelPublish;
  }, [
    automaticSettingsSync,
    user?.pubkey,
    hasNip44Support,
    config,
    name,
    metadata.doc,
    update,
    cancelPublish,
  ]);
}

export type { ConfigDocName };
