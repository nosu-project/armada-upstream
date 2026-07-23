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

function metadataTags(patch: GroupMetadataPatch): string[][] {
  const tags: string[][] = [];
  if (patch.name !== undefined) tags.push(["name", patch.name]);
  if (patch.about !== undefined) tags.push(["about", patch.about]);
  if (patch.picture !== undefined) tags.push(["picture", patch.picture]);
  if (patch.banner !== undefined) tags.push(["banner", patch.banner]);
  if (patch.isPrivate !== undefined) {
    tags.push([patch.isPrivate ? "private" : "public"]);
    // Buzz relays take visibility as a `visibility` tag on the 9002 (the bare
    // NIP-29 marker tags aren't in their recognized set); NIP-29 relays
    // ignore the extra tag.
    tags.push(["visibility", patch.isPrivate ? "private" : "open"]);
  }
  if (patch.isClosed !== undefined) tags.push([patch.isClosed ? "closed" : "open"]);
  // `restricted`/`hidden` have no documented antonym tags; only assert them.
  if (patch.isRestricted) tags.push(["restricted"]);
  if (patch.isHidden) tags.push(["hidden"]);
  return tags;
}

/**
 * NIP-29 moderation actions, published to the group's host relay. The relay
 * enforces whether the sender's role permits each action.
 */
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
        // Roles ride BOTH shapes: NIP-29 relays read them from the `p` tag's
        // trailing slots; Buzz relays read a separate `["role", …]` tag (and
        // ignore the p-tag extras). Each side ignores the other's shape.
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
    mutationFn: (patch: GroupMetadataPatch) =>
      publishEvent({
        kind: KIND_EDIT_METADATA,
        content: "",
        tags: [["h", groupId], ...metadataTags(patch)],
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

/** Create a new group (kind 9007) on a server. */
export function useCreateGroup(relayUrl: string) {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ groupId, extraTags }: { groupId: string; extraTags?: string[][] }) => {
      return publishEvent({
        kind: KIND_CREATE_GROUP,
        content: "",
        // Buzz relays take the channel metadata inline on the 9007 (`name` is
        // REQUIRED there, plus optional visibility/channel_type/about tags);
        // plain NIP-29 relays ignore the extras and take a follow-up 9002.
        tags: [["h", groupId], ...(extraTags ?? [])],
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "groups", relayUrl] });
    },
  });
}
