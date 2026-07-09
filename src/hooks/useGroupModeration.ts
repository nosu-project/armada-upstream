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
  if (patch.isPrivate !== undefined) tags.push([patch.isPrivate ? "private" : "public"]);
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
        tags: [["h", groupId], ["p", pubkey, ...roles]],
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
    mutationFn: async ({ groupId }: { groupId: string }) => {
      return publishEvent({
        kind: KIND_CREATE_GROUP,
        content: "",
        tags: [["h", groupId]],
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "groups", relayUrl] });
    },
  });
}
