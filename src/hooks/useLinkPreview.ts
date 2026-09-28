import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { linkPreviewUrl } from "@/lib/platform";
import {
  BlueskyPostSchema,
  GitHubIssueSchema,
  GitHubRepoSchema,
  HackerNewsItemSchema,
  WikipediaSummarySchema,
  extractBlueskyPost,
  extractGitHub,
  extractHackerNews,
  extractWikipedia,
  fromBlueskyPost,
  fromGitHubIssue,
  fromGitHubRepo,
  fromHackerNews,
  fromOEmbed,
  fromWikipedia,
  type RichEmbed,
} from "@/lib/richEmbed";

const OEmbedSchema = z.object({
  type: z.enum(["link", "photo", "video", "rich"]),
  version: z.string().optional(),
  title: z.string().optional(),
  author_name: z.string().optional(),
  author_url: z.url().optional(),
  provider_name: z.string().optional(),
  provider_url: z.url().optional(),
  thumbnail_url: z.url().optional(),
  thumbnail_width: z.number().optional(),
  thumbnail_height: z.number().optional(),
  url: z.url().optional(),
  html: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export type OEmbedData = z.infer<typeof OEmbedSchema>;

/** Known providers' native endpoints; null if unmatched or failed. */
async function tryNativeOEmbed(url: string, signal?: AbortSignal): Promise<OEmbedData | null> {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

    if (host === "youtube.com" || host === "youtu.be") {
      return await tryFetchOEmbed(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        signal,
      );
    }

    if (host === "open.spotify.com") {
      return await tryFetchOEmbed(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
        signal,
      );
    }

    return null;
  } catch {
    return null;
  }
}

async function tryFetchOEmbed(endpoint: string, signal?: AbortSignal): Promise<OEmbedData | null> {
  try {
    const response = await fetch(endpoint, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = OEmbedSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Known providers (YouTube, Spotify) natively; everything else via the optional preview proxy.
 * Not Reddit: its oEmbed sends no CORS header.
 */
async function fetchLinkPreview(url: string, signal?: AbortSignal): Promise<OEmbedData | null> {
  const native = await tryNativeOEmbed(url, signal);
  if (native) return native;

  const endpoint = linkPreviewUrl(url);
  if (!endpoint) return null;

  return tryFetchOEmbed(endpoint, signal);
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Richer cards from fixed first-party APIs with open CORS. Never a host the link chooses
 * (that would leak viewers' IPs to the sender). Null → generic preview.
 */
async function fetchProviderEmbed(url: string, signal?: AbortSignal): Promise<RichEmbed | null> {
  const bluesky = extractBlueskyPost(url);
  if (bluesky) {
    const uri = `at://${bluesky.actor}/app.bsky.feed.post/${bluesky.rkey}`;
    const params = new URLSearchParams({ uri, depth: "0", parentHeight: "0" });
    const thread = await fetchJson(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?${params}`,
      z.object({ thread: z.object({ post: BlueskyPostSchema }) }),
      signal,
    );
    return thread ? fromBlueskyPost(thread.thread.post) : null;
  }

  const github = extractGitHub(url);
  if (github) {
    // Unauthenticated: 60 reads/hour per IP; a 403 falls back to the generic card.
    const base = `https://api.github.com/repos/${github.owner}/${github.repo}`;
    if (github.number !== undefined) {
      const issue = await fetchJson(`${base}/issues/${github.number}`, GitHubIssueSchema, signal);
      return issue ? fromGitHubIssue(github, issue) : null;
    }
    const repo = await fetchJson(base, GitHubRepoSchema, signal);
    return repo ? fromGitHubRepo(repo) : null;
  }

  const wiki = extractWikipedia(url);
  if (wiki) {
    const page = await fetchJson(
      `https://${wiki.lang}.wikipedia.org/api/rest_v1/page/summary/${wiki.title}`,
      WikipediaSummarySchema,
      signal,
    );
    return page ? fromWikipedia(page) : null;
  }

  const hn = extractHackerNews(url);
  if (hn !== null) {
    const item = await fetchJson(
      `https://hacker-news.firebaseio.com/v0/item/${hn}.json`,
      HackerNewsItemSchema,
      signal,
    );
    return item ? fromHackerNews(item) : null;
  }

  return null;
}

/** A provider card without an image takes the page's og:image. */
async function fetchRichEmbed(url: string, signal?: AbortSignal): Promise<RichEmbed | null> {
  const [provider, oembed] = await Promise.all([
    fetchProviderEmbed(url, signal),
    fetchLinkPreview(url, signal).then(fromOEmbed),
  ]);
  if (!provider) return oembed;
  if (provider.images.length === 0 && oembed?.images.length) {
    return { ...provider, images: oembed.images };
  }
  return provider;
}

export function useRichEmbed(url: string | null) {
  return useQuery({
    queryKey: ["rich-embed", url],
    queryFn: ({ signal }) => fetchRichEmbed(url!, signal),
    enabled: !!url,
    // Counts move; the generic preview's hour would show a stale like count.
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
  });
}

export function useLinkPreview(url: string | null) {
  return useQuery({
    queryKey: ["link-preview", url],
    queryFn: ({ signal }) => fetchLinkPreview(url!, signal),
    enabled: !!url,
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
  });
}
