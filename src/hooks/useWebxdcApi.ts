import { useCallback, useEffect, useMemo, useRef } from "react";
import { nip19 } from "nostr-tools";

import type {
  Webxdc as WebxdcAPI,
  SendingStatusUpdate,
  ReceivedStatusUpdate,
  RealtimeListener,
} from "@webxdc/types/webxdc";

import { useCurrentUserProfile } from "@/hooks/useCurrentUser";
import { getDisplayName } from "@/lib/getDisplayName";

/**
 * Transport-agnostic backend for an in-chat app's coordination plane, wrapped
 * by {@link useWebxdcApi} into `window.webxdc`. "state" = durable, serial-ordered
 * `sendUpdate()`; "realtime" = transient best-effort frames. Scoped per app session.
 */
export interface AppSync {
  /** Durable state updates seen so far, oldest-first (serials assigned by index). */
  stateUpdates: AppStateUpdate[];
  sendState: (payload: unknown, opts?: AppStateMeta) => void;
  /** Publish a transient realtime frame (best-effort, not stored/ordered). */
  sendRealtime: (data: Uint8Array) => void;
  /** Subscribe to incoming realtime frames from *other* participants. Returns an unsubscribe. */
  onRealtime: (cb: (data: Uint8Array) => void) => () => void;
}

/** A decoded durable state update from the coordination plane. */
export interface AppStateUpdate {
  payload: unknown;
  info?: string;
  document?: string;
  summary?: string;
}

/** Optional metadata accompanying a state update (mirrors webxdc `sendUpdate`). */
export interface AppStateMeta {
  info?: string;
  document?: string;
  summary?: string;
}

/** Adapt an {@link AppSync} backend into the standard webxdc API exposed to the sandboxed app. */
export function useWebxdcApi(sync: AppSync): WebxdcAPI<unknown> {
  const { user, metadata } = useCurrentUserProfile();

  const selfPubkey = user?.pubkey;
  const selfAddr = useMemo(
    () => (selfPubkey ? nip19.npubEncode(selfPubkey) : "anonymous"),
    [selfPubkey],
  );
  const selfName = useMemo(
    () => (selfPubkey ? getDisplayName(metadata, selfPubkey) : "Anonymous"),
    [metadata, selfPubkey],
  );

  // Ref so the stable callbacks reach current data without churning the api object.
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  const updates = useMemo((): ReceivedStatusUpdate<unknown>[] => {
    return sync.stateUpdates.map((u, index) => ({
      payload: u.payload,
      serial: index + 1,
      max_serial: sync.stateUpdates.length,
      ...(u.info && { info: u.info }),
      ...(u.document && { document: u.document }),
      ...(u.summary && { summary: u.summary }),
    }));
  }, [sync.stateUpdates]);

  const listenerRef = useRef<((update: ReceivedStatusUpdate<unknown>) => void) | null>(null);
  const lastSerialRef = useRef(0);

  useEffect(() => {
    if (!listenerRef.current || !updates.length) return;
    const listener = listenerRef.current;
    for (const update of updates) {
      if (update.serial > lastSerialRef.current) {
        listener(update);
        lastSerialRef.current = update.serial;
      }
    }
  }, [updates]);

  const sendUpdate = useCallback(
    (update: SendingStatusUpdate<unknown>, _description: "") => {
      syncRef.current.sendState(update.payload, {
        info: update.info,
        document: update.document,
        summary: update.summary,
      });
    },
    [],
  );

  const setUpdateListener = useCallback(
    async (
      cb: (update: ReceivedStatusUpdate<unknown>) => void,
      serial?: number,
    ): Promise<void> => {
      listenerRef.current = cb;
      lastSerialRef.current = serial ?? 0;
      for (const update of updates) {
        if (update.serial > (serial ?? 0)) {
          cb(update);
          lastSerialRef.current = update.serial;
        }
      }
    },
    [updates],
  );

  const getAllUpdates = useCallback(
    async (): Promise<ReceivedStatusUpdate<unknown>[]> => updates,
    [updates],
  );

  const sendToChat = useCallback(async (): Promise<void> => {
    throw new Error("sendToChat is not supported");
  }, []);

  const importFiles = useCallback(async (): Promise<File[]> => [], []);

  const realtimeActiveRef = useRef(false);

  const joinRealtimeChannel = useCallback((): RealtimeListener => {
    if (realtimeActiveRef.current) {
      throw new Error("Already joined a realtime channel. Call leave() first.");
    }
    realtimeActiveRef.current = true;

    let listener: ((data: Uint8Array) => void) | null = null;
    const unsubscribe = syncRef.current.onRealtime((data) => {
      if (listener) listener(data);
    });

    return {
      setListener(cb: (data: Uint8Array) => void) {
        listener = cb;
      },
      send(data: Uint8Array) {
        if (!realtimeActiveRef.current) return;
        if (data.length > 128_000) {
          throw new Error("Realtime payload exceeds 128,000 byte limit");
        }
        syncRef.current.sendRealtime(data);
      },
      leave() {
        realtimeActiveRef.current = false;
        listener = null;
        unsubscribe();
      },
    };
  }, []);

  return useMemo<WebxdcAPI<unknown>>(
    () => ({
      selfAddr,
      selfName,
      sendUpdateInterval: 1000,
      sendUpdateMaxSize: 65536,
      sendUpdate,
      setUpdateListener,
      getAllUpdates,
      sendToChat,
      importFiles,
      joinRealtimeChannel,
    }),
    [selfAddr, selfName, sendUpdate, setUpdateListener, getAllUpdates, sendToChat, importFiles, joinRealtimeChannel],
  );
}
