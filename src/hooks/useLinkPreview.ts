import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

/** Generic link-preview proxy (OEmbed-shaped responses). */
const LINK_PREVIEW_TEMPLATE = "https://ditto.pub/api/link-preview/{url}";

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

    if (host === "reddit.com" || host === "old.reddit.com" || host === "new.reddit.com") {
      return await tryFetchOEmbed(
        `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`,
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
 * Fetch OEmbed data for a URL. Known providers (YouTube, Spotify, Reddit) are
 * queried at their native endpoints; everything else goes through the generic
 * link preview proxy.
 */
async function fetchLinkPreview(url: string, signal?: AbortSignal): Promise<OEmbedData | null> {
  const native = await tryNativeOEmbed(url, signal);
  if (native) return native;

  const endpoint = LINK_PREVIEW_TEMPLATE.replace("{url}", encodeURIComponent(url));
  return tryFetchOEmbed(endpoint, signal);
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
