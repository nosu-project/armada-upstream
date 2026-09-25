// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  GitHubIssueSchema,
  GitHubRepoSchema,
  HackerNewsItemSchema,
  WikipediaSummarySchema,
  extractGitHub,
  extractHackerNews,
  extractWikipedia,
  fromGitHubIssue,
  fromGitHubRepo,
  fromHackerNews,
  fromOEmbed,
  fromWikipedia,
} from "@/lib/richEmbed";

describe("extractGitHub", () => {
  it("reads repos, issues and pull requests", () => {
    expect(extractGitHub("https://github.com/soapbox-pub/ditto")).toEqual({ owner: "soapbox-pub", repo: "ditto" });
    expect(extractGitHub("https://github.com/soapbox-pub/ditto.git")).toEqual({ owner: "soapbox-pub", repo: "ditto" });
    expect(extractGitHub("https://github.com/o/r/tree/main/src")).toEqual({ owner: "o", repo: "r" });
    expect(extractGitHub("https://github.com/o/r/issues/12")).toEqual({ owner: "o", repo: "r", number: 12 });
    expect(extractGitHub("https://github.com/o/r/pull/7/files")).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("ignores site pages and other hosts", () => {
    expect(extractGitHub("https://github.com/features/actions")).toBeNull();
    expect(extractGitHub("https://github.com/soapbox-pub")).toBeNull();
    expect(extractGitHub("https://gitlab.com/o/r")).toBeNull();
  });
});

describe("fromGitHubIssue", () => {
  it("reports a merged pull request and drops template comments", () => {
    const embed = fromGitHubIssue(
      { owner: "o", repo: "r", number: 1 },
      GitHubIssueSchema.parse({
        number: 1,
        title: "Run each test",
        state: "closed",
        body: "<!-- describe your change -->\nThe actual body",
        comments: 7,
        created_at: "2013-05-29T20:20:53Z",
        user: { login: "benjamn", avatar_url: "https://avatars.example/1" },
        pull_request: { merged_at: "2013-06-03T17:58:02Z" },
      }),
    );
    expect(embed.title).toBe("Pull request #1: Run each test");
    expect(embed.description).toBe("The actual body");
    expect(embed.fields).toEqual([
      { name: "State", value: "Merged" },
      { name: "Comments", value: "7" },
    ]);
    expect(embed.footer?.timestamp).toBe(Date.parse("2013-05-29T20:20:53Z") / 1000);
  });
});

describe("fromGitHubRepo", () => {
  it("shows stars, forks and language", () => {
    const embed = fromGitHubRepo(
      GitHubRepoSchema.parse({
        full_name: "soapbox-pub/ditto",
        description: "Your content.",
        owner: { login: "soapbox-pub" },
        stargazers_count: 71,
        forks_count: 16,
        language: "TypeScript",
      }),
    );
    expect(embed.fields?.map((f) => f.name)).toEqual(["Stars", "Forks", "Language"]);
  });
});

describe("Wikipedia", () => {
  it("reads article URLs on any language and the mobile site", () => {
    expect(extractWikipedia("https://en.wikipedia.org/wiki/Whale")).toEqual({ lang: "en", title: "Whale" });
    expect(extractWikipedia("https://ja.m.wikipedia.org/wiki/%E9%AF%A8")).toEqual({ lang: "ja", title: "%E9%AF%A8" });
    expect(extractWikipedia("https://en.wikipedia.org/w/index.php?title=Whale")).toBeNull();
    expect(extractWikipedia("https://wikipedia.org.evil.example/wiki/Whale")).toBeNull();
  });

  it("keeps the thumbnail for the card and the original for the lightbox", () => {
    const embed = fromWikipedia(
      WikipediaSummarySchema.parse({
        title: "Whale",
        description: "Informal group of large marine mammals",
        extract: "Whales are…",
        thumbnail: { source: "https://upload.example/330px.jpg", width: 330, height: 495 },
        originalimage: { source: "https://upload.example/full.jpg", width: 683, height: 1024 },
      }),
    );
    expect(embed.images).toEqual([
      { thumb: "https://upload.example/330px.jpg", full: "https://upload.example/full.jpg", width: 330, height: 495 },
    ]);
  });
});

describe("Hacker News", () => {
  it("reads item URLs", () => {
    expect(extractHackerNews("https://news.ycombinator.com/item?id=8863")).toBe(8863);
    expect(extractHackerNews("https://news.ycombinator.com/news")).toBeNull();
  });

  it("shows points and comments, and the text of an Ask HN", () => {
    const embed = fromHackerNews(
      HackerNewsItemSchema.parse({
        type: "story",
        by: "dhouston",
        title: "Ask HN: something",
        text: "First<p>Second &amp; more",
        score: 104,
        descendants: 71,
        time: 1175714200,
      }),
    )!;
    expect(embed.description).toBe("First\n\nSecond & more");
    expect(embed.fields).toEqual([
      { name: "Points", value: "104" },
      { name: "Comments", value: "71" },
    ]);
  });

  it("shows nothing for a dead item", () => {
    expect(fromHackerNews(HackerNewsItemSchema.parse({ type: "story", dead: true }))).toBeNull();
  });
});

describe("Reddit", () => {
  it("splits the subreddit out of the preview title and hides a mature post's image", () => {
    const embed = fromOEmbed({
      provider_name: "Reddit",
      title: "[Mature Content] From the pics community on Reddit: A title",
      thumbnail_url: "https://img.example/x.png",
    })!;
    expect(embed.author).toEqual({ name: "r/pics" });
    expect(embed.title).toBe("A title");
    expect(embed.images).toEqual([]);
  });
});
