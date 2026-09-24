import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "web",
  pluginAvailable: false,
  open: vi.fn(async (_options: { videoId: string }): Promise<void> => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform !== "web",
    isPluginAvailable: () => native.pluginAvailable,
  },
  registerPlugin: () => ({ open: native.open }),
}));

const preview = vi.hoisted(() => ({ embed: null as RichEmbed | null }));

vi.mock("@/hooks/useLinkPreview", () => ({
  useLinkPreview: () => ({ data: null, isLoading: false }),
  useRichEmbed: () => ({ data: preview.embed, isLoading: false }),
}));

vi.mock("@/hooks/useMediaPolicy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useMediaPolicy")>()),
  useMediaSrc: (src: string | undefined) => src,
}));

import { LinkEmbed, YouTubeEmbed } from "@/components/chat/LinkEmbed";
import { oembedDescription } from "@/lib/linkEmbed";
import { BlueskyPostSchema, extractBlueskyPost, fromBlueskyPost, fromOEmbed, type RichEmbed } from "@/lib/richEmbed";

const BLUESKY_HTML =
  '<blockquote class="bluesky-embed"><p lang="en">discord casually admitting &amp; more</p>&mdash; ' +
  '<a href="https://bsky.app/profile/x">Gulumunkus</a></blockquote>' +
  '<script async src="https://embed.bsky.app/static/embed.js"></script>';

describe("oembedDescription", () => {
  it("reads the post text out of a blockquote embed", () => {
    expect(oembedDescription(BLUESKY_HTML)).toBe("discord casually admitting & more");
  });

  it("returns nothing for html with no quoted paragraphs", () => {
    expect(oembedDescription('<iframe src="https://example.com"></iframe>')).toBeUndefined();
    expect(oembedDescription(undefined)).toBeUndefined();
  });
});

describe("LinkPreview", () => {
  it("shows the post text and the whole image, not a cropped banner", () => {
    preview.embed = fromOEmbed({
      title: "Gulumunkus (@gulumunkus.bsky.social)",
      author_name: "Gulumunkus (@gulumunkus.bsky.social)",
      provider_name: "Bluesky Social",
      html: BLUESKY_HTML,
      thumbnail_url: "https://cdn.example/img.jpg",
      thumbnail_width: 600,
      thumbnail_height: 806,
    });
    render(<LinkEmbed url="https://bsky.app/profile/x/post/y" />);

    expect(screen.getByText("discord casually admitting & more")).toBeInTheDocument();
    // The author line is dropped when it only repeats the title.
    expect(screen.getAllByText("Gulumunkus (@gulumunkus.bsky.social)")).toHaveLength(1);

    const img = screen.getByRole("button", { name: "View image" }).querySelector("img")!;
    expect(img.className).not.toContain("max-h-[180px]");
    // 600×806 fitted into 400×320 without distortion.
    expect(img.style.aspectRatio).toBe("600 / 806");
    expect(img.style.width).toBe("238px");
  });

  it("opens the image in the lightbox instead of following the link", () => {
    preview.embed = fromOEmbed({
      title: "Artwork",
      thumbnail_url: "https://cdn.example/art.jpg",
      thumbnail_width: 849,
      thumbnail_height: 1200,
    });
    render(<LinkEmbed url="https://example.com/art" />);

    // fireEvent returns false when the default (following the link) was prevented.
    expect(fireEvent.click(screen.getByRole("button", { name: "View image" }))).toBe(false);
    expect(document.querySelector("[data-lightbox-content]")).toBeInTheDocument();
  });

  it("shows a small image as a side thumbnail", () => {
    preview.embed = fromOEmbed({
      title: "A repo",
      thumbnail_url: "https://cdn.example/logo.png",
      thumbnail_width: 128,
      thumbnail_height: 128,
    });
    render(<LinkEmbed url="https://example.com/repo" />);
    expect(screen.getByRole("button", { name: "View image" }).querySelector("img")!.className).toContain("size-20");
  });

  it("shows a Bluesky post's counts, every image and a timestamped footer", () => {
    preview.embed = fromBlueskyPost(
      BlueskyPostSchema.parse({
        author: { handle: "gulumunkus.bsky.social", displayName: "Gulumunkus", avatar: "https://cdn.example/a.jpg" },
        record: { text: "post body" },
        embed: {
          $type: "app.bsky.embed.images#view",
          images: [
            { thumb: "https://cdn.example/1.jpg", fullsize: "https://cdn.example/1-full.jpg", aspectRatio: { width: 600, height: 806 } },
            { thumb: "https://cdn.example/2.jpg" },
          ],
        },
        repostCount: 1318,
        likeCount: 4149,
        quoteCount: 110,
        indexedAt: "2026-09-24T02:39:31.757Z",
      }),
    );
    render(<LinkEmbed url="https://bsky.app/profile/gulumunkus.bsky.social/post/3mwaa3bueuk2z" />);

    expect(screen.getByText("Gulumunkus (@gulumunkus.bsky.social)")).toBeInTheDocument();
    expect(screen.getByText("post body")).toBeInTheDocument();
    expect(screen.getByText("Likes").nextSibling).toHaveTextContent((4149).toLocaleString());
    expect(screen.getByText("Reposts")).toBeInTheDocument();
    expect(screen.getByText("Quotes")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "View image" })).toHaveLength(2);
    expect(screen.getByText(/^Bluesky •/)).toBeInTheDocument();
  });

  it("recognizes only bsky.app post URLs", () => {
    expect(extractBlueskyPost("https://bsky.app/profile/a.bsky.social/post/3mwaa3bueuk2z")).toEqual({
      actor: "a.bsky.social",
      rkey: "3mwaa3bueuk2z",
    });
    expect(extractBlueskyPost("https://bsky.app/profile/did:plc:abc/post/3m")).toEqual({ actor: "did:plc:abc", rkey: "3m" });
    expect(extractBlueskyPost("https://bsky.app/profile/a.bsky.social")).toBeNull();
    expect(extractBlueskyPost("https://evil.example/profile/a/post/b")).toBeNull();
  });

  it("drops the media of a Bluesky post labelled adult", () => {
    const embed = fromBlueskyPost(
      BlueskyPostSchema.parse({
        author: { handle: "a.bsky.social" },
        record: { text: "x" },
        embed: { $type: "app.bsky.embed.images#view", images: [{ thumb: "https://cdn.example/1.jpg" }] },
        labels: [{ val: "porn" }],
      }),
    );
    expect(embed.images).toEqual([]);
  });
});

beforeEach(() => {
  native.platform = "web";
  native.pluginAvailable = false;
  native.open.mockClear().mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("YouTubeEmbed", () => {
  it("does not contact YouTube until the viewer clicks play", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });

  it("lets the browser identify the deployment that actually hosts Armada", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const iframe = screen.getByTitle<HTMLIFrameElement>("YouTube video");
    expect(iframe).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");

    const playerUrl = new URL(iframe.src);
    expect(playerUrl.origin).toBe("https://www.youtube-nocookie.com");
    expect(playerUrl.searchParams.get("origin")).toBeNull();
    expect(iframe.outerHTML).not.toContain("buzz.armada.app");
  });

  it("keeps Capacitor Android on the HTTPS-referrer iframe path", () => {
    native.platform = "android";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(screen.getByTitle("YouTube video")).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    expect(native.open).not.toHaveBeenCalled();
  });

  it("uses the referrer-bearing native player on Capacitor iOS", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    await waitFor(() => expect(native.open).toHaveBeenCalledWith({ videoId: "dQw4w9WgXcQ" }));
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });

  it("offers a user-activated watch-page fallback when native presentation fails", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    native.open.mockRejectedValue(new Error("presentation failed"));
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const fallback = await screen.findByRole("button", { name: "Open video on YouTube" });
    expect(openWindow).not.toHaveBeenCalled();
    fireEvent.click(fallback);
    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens the watch page instead of a broken iframe on older iOS builds", () => {
    native.platform = "ios";
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });
});
