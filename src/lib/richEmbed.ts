import { z } from "zod";

import { oembedDescription } from "@/lib/linkEmbed";

/** One image of a link preview: the card's thumbnail plus, when known, a full-size original for the lightbox. */
export interface RichEmbedImage {
  thumb: string;
  full?: string;
  width?: number;
  height?: number;
}

/**
 * A link preview in the shape the card renders, whichever source it came from
 * — a generic oEmbed, or a provider's own API where it says more (Bluesky's
 * counts, timestamp and every image rather than one og:image).
 */
export interface RichEmbed {
  /** Site name, shown above the content. */
  provider?: string;
  author?: { name: string; icon?: string };
  title?: string;
  description?: string;
  /** Labelled values in a row under the text (e.g. Likes / Reposts). */
  fields?: { name: string; value: string }[];
  images: RichEmbedImage[];
  /** Line under the media: the source, and when it was posted. */
  footer?: { text: string; timestamp?: number };
}

/** The oEmbed fields {@link fromOEmbed} reads. */
export interface OEmbedLike {
  title?: string;
  author_name?: string;
  provider_name?: string;
  html?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
}

/** A generic oEmbed as a {@link RichEmbed}, or null when it has nothing to show. */
export function fromOEmbed(data: OEmbedLike | null | undefined): RichEmbed | null {
  if (!data?.title && !data?.thumbnail_url) return null;
  const reddit = data.provider_name === "Reddit" ? fromRedditTitle(data.title) : null;
  if (reddit) {
    return {
      provider: "Reddit",
      author: { name: reddit.subreddit },
      title: reddit.title,
      // A post Reddit marks mature keeps its image off the card, as Reddit
      // itself hides it behind a click.
      images: data.thumbnail_url && !reddit.mature
        ? [{ thumb: data.thumbnail_url, width: data.thumbnail_width, height: data.thumbnail_height }]
        : [],
    };
  }
  return {
    provider: data.provider_name,
    // An author that only repeats the title (Bluesky's oEmbed does) is noise.
    author: data.author_name && data.author_name !== data.title ? { name: data.author_name } : undefined,
    title: data.title,
    description: oembedDescription(data.html),
    images: data.thumbnail_url
      ? [{ thumb: data.thumbnail_url, width: data.thumbnail_width, height: data.thumbnail_height }]
      : [],
  };
}

/** Handle or DID, and the record key, of a `bsky.app/profile/<actor>/post/<rkey>` URL. */
export function extractBlueskyPost(url: string): { actor: string; rkey: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "bsky.app" && u.hostname !== "www.bsky.app") return null;
    const m = /^\/profile\/([A-Za-z0-9._:%-]+)\/post\/([A-Za-z0-9._~:-]+)\/?$/.exec(u.pathname);
    if (!m) return null;
    return { actor: decodeURIComponent(m[1]), rkey: m[2] };
  } catch {
    return null;
  }
}

const AspectRatio = z.object({ width: z.number(), height: z.number() }).optional();

const ImagesView = z.object({
  $type: z.literal("app.bsky.embed.images#view"),
  images: z.array(z.object({ thumb: z.string(), fullsize: z.string().optional(), aspectRatio: AspectRatio })),
});
const VideoView = z.object({
  $type: z.literal("app.bsky.embed.video#view"),
  thumbnail: z.string().optional(),
  aspectRatio: AspectRatio,
});
const ExternalView = z.object({
  $type: z.literal("app.bsky.embed.external#view"),
  external: z.object({ thumb: z.string().optional() }),
});
const MediaView = z.union([ImagesView, VideoView, ExternalView]);
const RecordWithMediaView = z.object({
  $type: z.literal("app.bsky.embed.recordWithMedia#view"),
  media: MediaView,
});

const Label = z.object({ val: z.string() });

/** The part of an `app.bsky.feed.defs#postView` the card reads. */
export const BlueskyPostSchema = z.object({
  author: z.object({
    handle: z.string(),
    displayName: z.string().optional(),
    avatar: z.string().optional(),
    labels: z.array(Label).optional(),
  }),
  record: z.object({ text: z.string().optional() }),
  embed: z.unknown().optional(),
  repostCount: z.number().optional(),
  likeCount: z.number().optional(),
  quoteCount: z.number().optional(),
  indexedAt: z.string().optional(),
  labels: z.array(Label).optional(),
});

export type BlueskyPost = z.infer<typeof BlueskyPostSchema>;

/** Labels Bluesky itself hides media behind by default; a card has no warning to show instead. */
const ADULT_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media", "gore"]);

function mediaOf(embed: unknown): RichEmbedImage[] {
  const withMedia = RecordWithMediaView.safeParse(embed);
  const parsed = MediaView.safeParse(withMedia.success ? withMedia.data.media : embed);
  if (!parsed.success) return [];
  const view = parsed.data;
  switch (view.$type) {
    case "app.bsky.embed.images#view":
      return view.images.map((img) => ({
        thumb: img.thumb,
        full: img.fullsize,
        width: img.aspectRatio?.width,
        height: img.aspectRatio?.height,
      }));
    case "app.bsky.embed.video#view":
      return view.thumbnail
        ? [{ thumb: view.thumbnail, width: view.aspectRatio?.width, height: view.aspectRatio?.height }]
        : [];
    case "app.bsky.embed.external#view":
      return view.external.thumb ? [{ thumb: view.external.thumb }] : [];
  }
}

const COUNT = new Intl.NumberFormat();

/** A Bluesky post view as a {@link RichEmbed}: its text, counts, images and time. */
export function fromBlueskyPost(post: BlueskyPost): RichEmbed {
  const { author } = post;
  const labelled = [...(post.labels ?? []), ...(author.labels ?? [])].some((l) => ADULT_LABELS.has(l.val));

  return {
    author: {
      name: author.displayName ? `${author.displayName} (@${author.handle})` : `@${author.handle}`,
      icon: author.avatar,
    },
    description: post.record.text?.trim() || undefined,
    fields: countFields([
      ["Reposts", post.repostCount],
      ["Likes", post.likeCount],
      ["Quotes", post.quoteCount],
    ]),
    images: labelled ? [] : mediaOf(post.embed),
    footer: { text: "Bluesky", timestamp: unixSeconds(post.indexedAt) },
  };
}

/**
 * Reddit's API refuses unauthenticated reads and its oEmbed sends no CORS
 * header, so a Reddit link only ever gets the preview endpoint's og tags, whose
 * title folds the subreddit and a mature flag into one string:
 * `[Mature Content] From the linux community on Reddit: <title>`.
 */
function fromRedditTitle(
  title: string | undefined,
): { subreddit: string; title: string; mature: boolean } | null {
  const m = /^(\[Mature Content\] )?From the (\S+) community on Reddit: ([\s\S]+)$/.exec(title ?? "");
  return m ? { subreddit: `r/${m[2]}`, title: m[3].trim(), mature: !!m[1] } : null;
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/** First path segments on github.com that are site pages, not owners. */
const GITHUB_RESERVED = new Set([
  "about", "apps", "collections", "customer-stories", "enterprise", "explore", "features",
  "issues", "login", "marketplace", "new", "notifications", "orgs", "organizations", "pricing",
  "pulls", "search", "security", "settings", "signup", "site", "sponsors", "topics", "trending",
]);

export type GitHubTarget = { owner: string; repo: string; number?: number };

/** The repo, or the repo and issue/PR number, a `github.com` URL names. */
export function extractGitHub(url: string): GitHubTarget | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const [owner, rawRepo, section, num] = u.pathname.split("/").filter(Boolean);
    if (!owner || !rawRepo || GITHUB_RESERVED.has(owner.toLowerCase())) return null;
    const repo = rawRepo.replace(/\.git$/, "");
    const name = /^[A-Za-z0-9_.-]+$/;
    if (!name.test(owner) || !name.test(repo)) return null;
    if ((section === "issues" || section === "pull") && num && /^\d+$/.test(num)) {
      return { owner, repo, number: Number(num) };
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

const GitHubUser = z.object({ login: z.string(), avatar_url: z.string().optional() });

export const GitHubRepoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable().optional(),
  owner: GitHubUser,
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  language: z.string().nullable().optional(),
});

export const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  body: z.string().nullable().optional(),
  comments: z.number().optional(),
  created_at: z.string().optional(),
  user: GitHubUser.nullable(),
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
});

function unixSeconds(iso: string | undefined): number | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function countFields(counts: [string, number | undefined | null][]): RichEmbed["fields"] {
  const fields = counts.flatMap(([name, n]) => (typeof n === "number" ? [{ name, value: COUNT.format(n) }] : []));
  return fields.length ? fields : undefined;
}

export function fromGitHubRepo(repo: z.infer<typeof GitHubRepoSchema>): RichEmbed {
  const fields = countFields([
    ["Stars", repo.stargazers_count],
    ["Forks", repo.forks_count],
  ]) ?? [];
  if (repo.language) fields.push({ name: "Language", value: repo.language });
  return {
    provider: "GitHub",
    author: { name: repo.owner.login, icon: repo.owner.avatar_url },
    title: repo.full_name,
    description: repo.description?.trim() || undefined,
    fields: fields.length ? fields : undefined,
    images: [],
  };
}

export function fromGitHubIssue(target: GitHubTarget, issue: z.infer<typeof GitHubIssueSchema>): RichEmbed {
  const isPull = !!issue.pull_request;
  const state = issue.pull_request?.merged_at
    ? "Merged"
    : issue.draft && issue.state === "open"
      ? "Draft"
      : issue.state === "open" ? "Open" : "Closed";
  // Issue and PR templates leave their instructions as HTML comments.
  const body = issue.body?.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 600);
  return {
    provider: `GitHub · ${target.owner}/${target.repo}`,
    author: issue.user ? { name: issue.user.login, icon: issue.user.avatar_url } : undefined,
    title: `${isPull ? "Pull request" : "Issue"} #${issue.number}: ${issue.title}`,
    description: body || undefined,
    fields: [
      { name: "State", value: state },
      ...(countFields([["Comments", issue.comments]]) ?? []),
    ],
    images: [],
    footer: { text: "GitHub", timestamp: unixSeconds(issue.created_at) },
  };
}

// ── Wikipedia ───────────────────────────────────────────────────────────────

/** Language subdomain and (still percent-encoded) title of a Wikipedia article URL. */
export function extractWikipedia(url: string): { lang: string; title: string } | null {
  try {
    const u = new URL(url);
    const host = /^([a-z][a-z0-9-]*)(?:\.m)?\.wikipedia\.org$/.exec(u.hostname);
    const path = /^\/wiki\/([^/]+)$/.exec(u.pathname);
    if (!host || !path || host[1] === "www") return null;
    return { lang: host[1], title: path[1] };
  } catch {
    return null;
  }
}

const WikiImage = z.object({ source: z.string(), width: z.number().optional(), height: z.number().optional() });

export const WikipediaSummarySchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  extract: z.string().optional(),
  thumbnail: WikiImage.optional(),
  originalimage: WikiImage.optional(),
});

export function fromWikipedia(page: z.infer<typeof WikipediaSummarySchema>): RichEmbed {
  const thumb = page.thumbnail ?? page.originalimage;
  return {
    provider: "Wikipedia",
    title: page.title,
    author: page.description ? { name: page.description } : undefined,
    description: page.extract?.trim() || undefined,
    images: thumb
      ? [{ thumb: thumb.source, full: page.originalimage?.source, width: thumb.width, height: thumb.height }]
      : [],
  };
}

// ── Hacker News ─────────────────────────────────────────────────────────────

/** The item id of a `news.ycombinator.com/item?id=<n>` URL. */
export function extractHackerNews(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "news.ycombinator.com" || u.pathname !== "/item") return null;
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? Number(id) : null;
  } catch {
    return null;
  }
}

export const HackerNewsItemSchema = z.object({
  type: z.string(),
  by: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  score: z.number().optional(),
  descendants: z.number().optional(),
  time: z.number().optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});

/** HN's `text` is HTML with bare `<p>` separators; only its text is kept. */
function hnText(html: string | undefined): string | undefined {
  if (!html || typeof DOMParser === "undefined") return undefined;
  const doc = new DOMParser().parseFromString(html.replace(/<p>/gi, "\n\n"), "text/html");
  return doc.body.textContent?.trim() || undefined;
}

export function fromHackerNews(item: z.infer<typeof HackerNewsItemSchema>): RichEmbed | null {
  if (item.deleted || item.dead) return null;
  let linked: string | undefined;
  try {
    linked = item.url ? new URL(item.url).hostname.replace(/^www\./, "") : undefined;
  } catch {
    linked = undefined;
  }
  return {
    provider: "Hacker News",
    author: item.by ? { name: item.by } : undefined,
    title: item.title ?? (item.type === "comment" ? "Comment" : undefined),
    description: hnText(item.text) ?? linked,
    fields: countFields([
      ["Points", item.score],
      ["Comments", item.descendants],
    ]),
    images: [],
    footer: item.time ? { text: "Hacker News", timestamp: item.time } : undefined,
  };
}
