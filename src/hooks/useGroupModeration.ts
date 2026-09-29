import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  KIND_CREATE_GROUP,
  KIND_CREATE_INVITE,
  KIND_DELETE_EVENT,
  KIND_DELETE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
} from "@/lib/nip29";

import type { NostrRumor } from "@/lib/nostrRumor";

export interface GroupMetadataPatch {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  isPrivate?: boolean;
  isRestricted?: boolean;
  isClosed?: boolean;
  isHidden?: boolean;
}

/** Flag tags and the antonyms relay29 reads to clear them. */
const FLAG_TAGS: Record<string, keyof GroupMetadataPatch> = {
  private: "isPrivate",
  public: "isPrivate",
  visibility: "isPrivate",
  closed: "isClosed",
  open: "isClosed",
  restricted: "isRestricted",
  hidden: "isHidden",
};

/**
 * A 9002 carries ALL the group's metadata (NIP-29), so it starts from the current
 * 39000 and overlays the patch: fields Armada has no editor for (`livekit`,
 * `supported_kinds`, subgroup `parent`/`child`) survive, and a relay that treats the
 * edit as a replacement loses nothing — one with subgroups rejects an edit missing
 * any `child`.
 */
export function metadataTags(patch: GroupMetadataPatch, current?: NostrRumor): string[][] {
  const patched = (name: string): boolean => {
    const field = FLAG_TAGS[name] ?? (name as keyof GroupMetadataPatch);
    return patch[field] !== undefined;
  };
  const tags: string[][] = (current?.tags ?? []).filter(([name]) => name !== "d" && !patched(name));

  if (patch.name !== undefined) tags.push(["name", patch.name]);
  if (patch.about !== undefined) tags.push(["about", patch.about]);
  if (patch.picture !== undefined) tags.push(["picture", patch.picture]);
  if (patch.banner !== undefined) tags.push(["banner", patch.banner]);
  if (patch.isPrivate !== undefined) {
    tags.push([patch.isPrivate ? "private" : "public"]);
    // Buzz relays read visibility from a `visibility` tag; NIP-29 relays ignore it.
    tags.push(["visibility", patch.isPrivate ? "private" : "open"]);
  }
  if (patch.isClosed !== undefined) tags.push([patch.isClosed ? "closed" : "open"]);
  // `restricted`/`hidden` have no documented antonym tags; omitting one clears it.
  if (patch.isRestricted) tags.push(["restricted"]);
  if (patch.isHidden) tags.push(["hidden"]);
  return tags;
}

/** Published to the host relay, which enforces role permissions. */
export function useGroupModeration(relayUrl: string, groupId: string) {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["nip29", "group", relayUrl, groupId] });
    queryClient.invalidateQueries({ queryKey: ["nip29", "groups", relayUrl] });
    queryClient.invalidateQueries({ queryKey: ["nip29", "membership", relayUrl, groupId] });
  };

  const putUser = useMutation({
    mutationFn: ({ pubkey, roles = [] }: { pubkey: string; roles?: string[] }) =>
      publishEvent({
        kind: KIND_PUT_USER,
        content: "",
        // Roles in both shapes: NIP-29 reads `p` tag extras; Buzz reads `["role", …]`.
        tags: [
          ["h", groupId],
          ["p", pubkey, ...roles],
          ...(roles.length > 0 ? [["role", roles[0]]] : []),
        ],
        relay: relayUrl,
      }),
    onSuccess: invalidate,
  });

  const removeUser = useMutation({
    mutationFn: ({ pubkey, reason }: { pubkey: string; reason?: string }) =>
      publishEvent({
        kind: KIND_REMOVE_USER,
        content: reason ?? "",
        tags: [["h", groupId], ["p", pubkey]],
        relay: relayUrl,
      }),
    onSuccess: invalidate,
  });

  const deleteEvent = useMutation({
    mutationFn: ({ eventId, reason }: { eventId: string; reason?: string }) =>
      publishEvent({
        kind: KIND_DELETE_EVENT,
        content: reason ?? "",
        tags: [["h", groupId], ["e", eventId]],
        relay: relayUrl,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "messages", relayUrl, groupId] });
    },
  });

  const editMetadata = useMutation({
    mutationFn: ({ patch, current }: { patch: GroupMetadataPatch; current?: NostrRumor }) =>
      publishEvent({
        kind: KIND_EDIT_METADATA,
        content: "",
        tags: [["h", groupId], ...metadataTags(patch, current)],
        relay: relayUrl,
      }),
    onSuccess: invalidate,
  });

  const deleteGroup = useMutation({
    mutationFn: ({ reason }: { reason?: string } = {}) =>
      publishEvent({
        kind: KIND_DELETE_GROUP,
        content: reason ?? "",
        tags: [["h", groupId]],
        relay: relayUrl,
      }),
    onSuccess: invalidate,
  });

  const createInvite = useMutation({
    mutationFn: ({ code }: { code: string }) =>
      publishEvent({
        kind: KIND_CREATE_INVITE,
        content: "",
        tags: [["h", groupId], ["code", code]],
        relay: relayUrl,
      }),
  });

  return { putUser, removeUser, deleteEvent, editMetadata, deleteGroup, createInvite };
}

export function useCreateGroup(relayUrl: string) {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ groupId, extraTags }: { groupId: string; extraTags?: string[][] }) => {
      return publishEvent({
        kind: KIND_CREATE_GROUP,
        content: "",
        // Buzz takes metadata inline on the 9007 (`name` REQUIRED); NIP-29 relays use a follow-up 9002.
        tags: [["h", groupId], ...(extraTags ?? [])],
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "groups", relayUrl] });
    },
  });
}
