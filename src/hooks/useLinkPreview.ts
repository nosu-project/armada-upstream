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

/** Zod schema for OEmbed responses from the link preview endpoint. */
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

/** OEmbed response from the link preview endpoint. */
export type OEmbedData = z.infer<typeof OEmbedSchema>;

/**
 * Try to fetch OEmbed data directly from a known provider's native endpoint.
 * Returns null if the URL doesn't match a known provider or the fetch fails.
 */
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

/** Try to parse an OEmbed response from a standard endpoint, returning null on failure. */
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
 * Fetch OEmbed data for a URL. Known providers (YouTube, Spotify) are queried
 * at their native endpoints; everything else goes through the generic link
 * preview proxy, which the build may leave unconfigured. (Not Reddit: its
 * oEmbed sends no CORS header, so a browser can only ever read it through the
 * proxy.)
 */
async function fetchLinkPreview(url: string, signal?: AbortSignal): Promise<OEmbedData | null> {
  const native = await tryNativeOEmbed(url, signal);
  if (native) return native;

  const endpoint = linkPreviewUrl(url);
  if (!endpoint) return null;

  return tryFetchOEmbed(endpoint, signal);
}

/** GET a JSON document and validate it, or null on any failure. */
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
 * A card from the linked site's own public API, for the few sites whose API
 * says more than their og tags (counts, times, every image) and answers a
 * browser: fixed, first-party hosts with open CORS. Never a host the link
 * itself chooses — that would hand every viewer's IP to whoever sent it.
 * Null when the URL is none of them or the read fails, so the caller falls
 * back to the generic preview.
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
    // Unauthenticated, this is 60 reads an hour per IP; a 403 past that falls
    // back to the generic card like any other failure.
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

/**
 * Preview card content for a URL: the provider's own API where one says more,
 * else the oEmbed. The two are read together, and a provider card with no
 * image of its own takes the page's og:image (GitHub's social card).
 */
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

/** Hook to fetch the preview card content for a URL. */
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

/** Hook to fetch OEmbed link preview data for a URL. */
export function useLinkPreview(url: string | null) {
  return useQuery({
    queryKey: ["link-preview", url],
    queryFn: ({ signal }) => fetchLinkPreview(url!, signal),
    enabled: !!url,
    staleTime: 1000 * 60 * 60, // 1 hour
    gcTime: 1000 * 60 * 60 * 24, // 24 hours
    retry: false,
  });
}
