import { useQuery } from "@tanstack/react-query";

/**
 * Fetch a YouTube video's title (and channel) via the keyless oEmbed endpoint —
 * no API key or quota needed. Used to label queued videos in the watchalong.
 * Returns `undefined` while loading or on failure (the caller falls back to the
 * raw id).
 */
export function useYouTubeTitle(videoId: string | undefined) {
  return useQuery({
    queryKey: ["youtube-oembed", videoId],
    enabled: Boolean(videoId),
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
    queryFn: async ({ signal }) => {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        { signal, headers: { Accept: "application/json" } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      return {
        title: data.title,
        author: data.author_name,
        thumbnail: data.thumbnail_url,
      };
    },
  });
}
