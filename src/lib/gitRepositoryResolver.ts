import { nip05, nip19 } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";

import {
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  parseGitRepositoryAddress,
  parseGitRepositoryAnnouncement,
  type GitRepositoryAddress,
  type GitRepositoryAnnouncement,
} from "@/lib/gitActivity";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";

/** index.ngit.dev only helps find repository announcements; it is never persisted as activity. */
export const GIT_ANNOUNCEMENT_DISCOVERY_RELAY = "wss://index.ngit.dev";

export type GitRepositoryResolution = {
  address: GitRepositoryAddress;
  relayHints: string[];
};

export type ResolvedGitRepository = GitRepositoryResolution & {
  announcement: GitRepositoryAnnouncement;
};

type NostrClient = {
  group(urls: string[]): {
    req(
      filters: { kinds: number[]; authors: string[]; "#d": string[] }[],
      options: { signal: AbortSignal; eoseTimeout: number },
    ): AsyncIterable<readonly unknown[]>;
  };
};

/**
 * Turn a supported user entry into a canonical repository coordinate. NIP-05
 * lookups go through nostr-tools' verified NIP-05 resolver rather than trusting
 * a profile metadata field.
 */
export async function resolveGitRepositoryInput(input: string): Promise<GitRepositoryResolution> {
  const value = input.trim();
  if (!value) throw new Error("Enter a repository address.");

  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "naddr") throw new Error("Unsupported Nostr address kind.");
    const data = decoded.data;
    if (data.kind !== GIT_REPOSITORY_ANNOUNCEMENT_KIND) throw new Error("Only kind-30617 repository addresses are supported.");
    const address = parseGitRepositoryAddress(`${data.kind}:${data.pubkey}:${data.identifier}`);
    if (!address) throw new Error("Repository address has an invalid owner or identifier.");
    return { address, relayHints: normalizedRelays(data.relays ?? []) };
  } catch (error) {
    // An actual naddr decoding/validation error should not be treated as a URI.
    if (value.toLowerCase().startsWith("naddr1")) {
      throw error instanceof Error ? error : new Error("Invalid repository address.");
    }
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter an naddr or nostr:// repository address.");
  }
  if (url.protocol !== "nostr:") throw new Error("Enter an naddr or nostr:// repository address.");
  // `username` is the NIP-05 local part in nostr://alice@example.com/repo.
  if (url.password || url.port || url.search || url.hash) throw new Error("Invalid nostr:// repository address.");

  // NIP-34's remote is `nostr://<owner>/<identifier>`, optionally carrying a
  // relay hint ahead of it (`nostr://<owner>/<relay>/<identifier>` — the form
  // ngit writes into .git/config, so it is what a user copies from a remote).
  // The identifier is always the LAST segment; a preceding one is a grasp host
  // to try first, which resolution treats as a preference, not a requirement.
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Error("Repository identifier is invalid.");
  }
  if (segments.length < 1 || segments.length > 2) {
    throw new Error("Repository identifier is required.");
  }
  const identifier = segments[segments.length - 1];
  const hintedRelays = segments.length === 2 ? [`wss://${segments[0]}`] : [];
  if (!identifier) throw new Error("Repository identifier is required.");

  let owner: string;
  if (url.hostname.toLowerCase().startsWith("npub1")) {
    try {
      const decoded = nip19.decode(url.hostname);
      if (decoded.type !== "npub" || !isNostrId(decoded.data)) throw new Error();
      owner = decoded.data;
    } catch {
      throw new Error("Repository owner is not a valid npub.");
    }
  } else {
    // A hostname cannot contain an @, so URL places NIP-05's local part in
    // username. This deliberately rejects bare domains as ambiguous owners.
    let nip05Address = "";
    try {
      nip05Address = url.username ? `${decodeURIComponent(url.username)}@${url.hostname}` : "";
    } catch {
      throw new Error("Repository owner is not a valid NIP-05 address.");
    }
    if (!nip05Address) throw new Error("Repository owner must be an npub or verified NIP-05 address.");
    const profile = await nip05.queryProfile(nip05Address);
    if (!profile || !isNostrId(profile.pubkey)) throw new Error("Couldn't verify that NIP-05 repository owner.");
    owner = profile.pubkey;
  }

  const address = parseGitRepositoryAddress(`${GIT_REPOSITORY_ANNOUNCEMENT_KIND}:${owner}:${identifier}`);
  if (!address) throw new Error("Repository address has an invalid owner or identifier.");
  return { address, relayHints: hintedRelays };
}

/** Fetch the newest exact announcement, preferring any relay hints supplied by the input. */
export async function resolveGitRepositoryAnnouncement(
  nostr: NostrClient,
  input: string,
  signal?: AbortSignal,
): Promise<ResolvedGitRepository> {
  const resolved = await resolveGitRepositoryInput(input);
  return fetchGitRepositoryAnnouncement(nostr, resolved, signal);
}

/** Fetch an already-canonical repository coordinate using its persisted hints. */
export async function fetchGitRepositoryAnnouncement(
  nostr: NostrClient,
  resolved: GitRepositoryResolution,
  signal?: AbortSignal,
): Promise<ResolvedGitRepository> {
  const primary = normalizedRelays(resolved.relayHints);
  const discovery = primary.includes(GIT_ANNOUNCEMENT_DISCOVERY_RELAY)
    ? []
    : [GIT_ANNOUNCEMENT_DISCOVERY_RELAY];
  let newest: GitRepositoryAnnouncement | undefined;

  const collect = async (relays: string[]) => {
    if (!relays.length) return;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    try {
      for await (const message of nostr.group(relays.slice(0, 10)).req(
        [{ kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], authors: [resolved.address.owner], "#d": [resolved.address.identifier] }],
        { signal: requestSignal, eoseTimeout: 4000 },
      )) {
        if (message[0] === "EOSE" || message[0] === "CLOSED") break;
        if (message[0] !== "EVENT") continue;
        const announcement = parseGitRepositoryAnnouncement(message[2] as NostrEvent);
        if (!announcement || announcement.address.coordinate !== resolved.address.coordinate) continue;
        if (!newest || announcement.createdAt > newest.createdAt) newest = announcement;
      }
    } catch {
      // Relay failures are expected during discovery; retain valid responses.
    }
  };

  await collect(primary);
  await collect(discovery);
  if (!newest) throw new Error("Repository announcement not found.");
  if (!newest.relays.length) throw new Error("Repository announcement has no usable activity relays.");
  return { ...resolved, announcement: newest, relayHints: normalizedRelays([...newest.relays, ...resolved.relayHints]) };
}

function normalizedRelays(relays: readonly string[]): string[] {
  return [...new Set(relays
    .filter((relay) => /^wss?:\/\//i.test(relay.trim()))
    .map(normalizeRelayUrl)
    .filter((relay): relay is string => Boolean(relay)))];
}
