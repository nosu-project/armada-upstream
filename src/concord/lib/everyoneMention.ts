import {
  isAuthorizedIn,
  Permissions,
  type CommunityRoles,
} from "@/concord/lib/roles";

/**
 * Concord reserves MENTION_EVERYONE as an authorization bit but does not
 * define a dedicated Chat Plane tag. Concord clients therefore use the
 * literal token in message content and authorize it against the channel's
 * current role fold.
 *
 * Do not match the middle of a word/email or a longer handle such as
 * `@everyone_else`. The spelling is deliberately lowercase to match the
 * interoperable token emitted by existing clients.
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
