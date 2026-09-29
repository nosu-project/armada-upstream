import {
  isAuthorizedIn,
  Permissions,
  type CommunityRoles,
} from "@/concord/lib/roles";

/**
 * Concord reserves MENTION_EVERYONE as a permission bit but defines no Chat Plane
 * tag, so clients use the literal lowercase `@everyone` token (interop with
 * existing clients), authorized against the channel's role fold. Never matches
 * inside a word/email or a longer handle like `@everyone_else`.
 */
export const EVERYONE_MENTION_PATTERN = /(^|[^\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_])/u;

export function hasEveryoneMention(content: string): boolean {
  return EVERYONE_MENTION_PATTERN.test(content);
}

/** Whether `author` may issue a mass mention in this exact channel. */
export function canMentionEveryone(
  roles: CommunityRoles,
  ownerHex: string | undefined,
  author: string,
  channelIdHex: string,
): boolean {
  return isAuthorizedIn(
    roles,
    author,
    ownerHex,
    channelIdHex,
    Permissions.MENTION_EVERYONE,
  );
}

/** A literal mass mention whose author is authorized in its channel. */
export function isEveryoneMention(
  content: string,
  roles: CommunityRoles,
  ownerHex: string | undefined,
  author: string,
  channelIdHex: string,
): boolean {
  return hasEveryoneMention(content)
    && canMentionEveryone(roles, ownerHex, author, channelIdHex);
}

/**
 * A mass mention addresses the members of its moment, so one sent before this
 * membership began (`joinedAtMs`, the vault entry's `added_at`) never pings.
 */
export function everyoneMentionReaches(sentAtMs: number, joinedAtMs: number | undefined): boolean {
  return joinedAtMs === undefined || sentAtMs >= joinedAtMs;
}

/**
 * Authors worth scanning for literal mass mentions across these channels.
 * The owner is implicit in the role graph; everyone else comes from Grants.
 */
export function everyoneMentionAuthors(
  roles: CommunityRoles,
  ownerHex: string | undefined,
  channelIdsHex: readonly string[],
): string[] {
  const candidates = new Set<string>();
  if (ownerHex) candidates.add(ownerHex);
  for (const grant of roles.grants) candidates.add(grant.member);
  return [...candidates]
    .filter((author) =>
      channelIdsHex.some((channelIdHex) =>
        canMentionEveryone(roles, ownerHex, author, channelIdHex),
      ),
    )
    .sort();
}
