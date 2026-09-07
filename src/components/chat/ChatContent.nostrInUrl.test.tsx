import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A NIP-19 entity embedded in a URL must not be pulled out as a mention when it
 * sits MID-PATH. A structured link like
 * `gitworkshop.dev/npub1…/relay.ngit.dev/armada/issues/nevent1…` carries the
 * repo owner's npub as a path segment; rendering that as a profile mention both
 * split the link and misattributed it. The URL must render as one link (with
 * `disableNoteEmbeds` the terminal `nevent1…` folds to a plain anchor rather
 * than mounting a card), scheme-less or schemed alike.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

let nextId = 0;

function message(content: string): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

/** Render with note embeds disabled, so a terminal nostr id folds to a plain
 *  anchor and no card (which would need a NostrProvider) has to mount. */
function renderContent(content: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={message(content)} disableNoteEmbeds />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The `href`s of every rendered link, in order. */
function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

const NPUB = "npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj";
const NEVENT =
  "nevent1qy28wumn8ghj7un9d3shjtnwva5hgtnyv4mqqgptns3tldj9dca3h32n0np2m99afuzj80f28u39g8dyl9h5nzfuay88aewl";
const PATH = `gitworkshop.dev/${NPUB}/relay.ngit.dev/armada/issues/${NEVENT}`;

describe("ChatContent nostr-in-URL", () => {
  it("keeps a scheme-less URL with a mid-path npub as one link", () => {
    const { container } = renderContent(`look ${PATH} here`);
    const links = hrefs(container);
    // Exactly one link; none of them is the ditto profile off-ramp for the npub.
    expect(links).toHaveLength(1);
    expect(links.some((h) => h.includes(NPUB))).toBe(false);
  });

  it("keeps a schemed URL with a mid-path npub as one link", () => {
    const { container } = renderContent(`look https://${PATH} here`);
    const links = hrefs(container);
    expect(links).toHaveLength(1);
    expect(links.some((h) => h.includes(NPUB))).toBe(false);
  });

  it("keeps a mid-sentence npub URL as a link to that URL", () => {
    // `https://ditto.pub/<npub>` is a link to ditto.pub. Unfolding it to a
    // mention chip (a `<button>`, so: no links at all) dropped the href the
    // sender wrote and pointed the reader at a profile page instead.
    const { container } = renderContent(`see https://ditto.pub/${NPUB} for more`);
    expect(hrefs(container)).toEqual([`https://ditto.pub/${NPUB}`]);
  });

  it("gives a standalone npub URL the ordinary link preview, not a mention", () => {
    // Alone on its line it takes the same LinkEmbed any other URL would (here
    // still in its loading state, hence no anchor yet) — the point is that it
    // is not a NostrMention chip, which renders as a button.
    const { container } = renderContent(`https://ditto.pub/${NPUB}`);
    expect(container.querySelector("button")).toBeNull();
  });

  it("still unfolds a terminal nostr id (njump-style link)", () => {
    const { container } = renderContent(`https://njump.me/${NEVENT}`);
    // With embeds disabled the terminal nevent folds to a single off-ramp
    // anchor (TruncatedNostrLink), not a profile mention for some other id.
    const links = hrefs(container);
    expect(links).toHaveLength(1);
    expect(links[0]).not.toContain(NPUB);
  });

  // The scheme-less-domain URL branch bounds its label/TLD repetition so a long
  // run of word-characters with no `.tld/` can't drive the tokenizer O(n²). A
  // pathological single-token message must render as plain text (no link) and,
  // implicitly, tokenize promptly — an unbounded pattern would hang here well
  // past the test timeout rather than fail an assertion.
  it("tokenizes a long dotless word run without a quadratic scan", () => {
    const start = performance.now();
    const { container } = renderContent("a".repeat(200_000));
    const elapsed = performance.now() - start;
    expect(hrefs(container)).toHaveLength(0);
    // Generous ceiling: the bounded scan is tens of ms, the unbounded one was
    // ~8s for this input. A loaded CI box has ample headroom under 4s.
    expect(elapsed).toBeLessThan(4000);
  });
});
