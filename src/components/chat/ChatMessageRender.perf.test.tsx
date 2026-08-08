import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

/**
 * Locates the channel-switch cost the fold/transport tests ruled OUT.
 *
 * chat.perf.test.ts + useTransport.perf.test.tsx showed the data layer is
 * cheap (2000 msgs fold in ~2ms). This measures the OTHER half of a switch:
 * mounting the message-row component trees to the DOM. Each row is
 * ChatMessage → MessageRow (avatar/name shell) + ChatContent (the markdown /
 * URL / emoji / hashtag tokenizer, ChatContent.tsx:346-904). That per-row DOM
 * + tokenization work — not the fold — is the candidate for felt lag, the same
 * shape as the MemberList finding (800 rows = ~1.2s).
 *
 * Scope: the Nostr/store leaf hooks (useAuthor, useCurrentUser, scoped
 * identity, mention map, custom emojis) are stubbed so the number is DOM +
 * tokenizer cost, not the query stack (which is batched anyway). ChatContent's
 * real tokenizer runs. Content is varied (plain / markdown / hashtag / emoji)
 * to exercise the tokenizer branches, and every message id is UNIQUE so the
 * module-level TOKEN_CACHE (ChatContent.tsx:306) does not hide re-tokenization.
 * Embeds/URLs are avoided so nothing does a network fetch.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
// The mute menu item's mutations reach for the relay pool; this tree has none.
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>(), ready: true }),
  useMuteToggle: () => ({
    muted: false,
    canMute: false,
    pending: false,
    label: "Mute",
    toggle: async () => {},
  }),
}));
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
vi.mock("@/hooks/useResolvedMediaSrc", () => ({
  useResolvedMediaSrc: (ref: unknown) => ({ src: typeof ref === "string" ? ref : undefined }),
}));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));

import { ChatContent } from "@/components/chat/ChatContent";
import { ChatMessage } from "@/components/chat/ChatMessage";

const AUTHORS = Array.from({ length: 24 }, (_, i) => i.toString(16).padStart(64, "0"));

// Synchronous tokenizer branches only — no bare URLs/nostr: ids (those mount
// embeds that can fetch). A trailing " zrow{i}" plain marker lets us count rows.
const BODIES = [
  "hello everyone, this is a perfectly ordinary chat message with a bit of length",
  "**bold** text, some _italics_, an `inline code` span, and a #hashtag in the mix",
  "a longer note.\n\nwith two blocks and\n- a\n- little\n- bullet list at the end",
  "emoji check 😀 🎉 🚀 followed by a few more words so it is not emoji-only",
];

function messages(n: number, salt: string): ChatMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    id: (salt + i.toString(16).padStart(8, "0")).padStart(64, "0"),
    pubkey: AUTHORS[i % AUTHORS.length],
    created_at: 1_700_000_000 + i,
    kind: 9,
    content: `${BODIES[i % BODIES.length]} zrow${i}`,
    tags: [],
  }) as ChatMsg);
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function rows(container: HTMLElement): number {
  return container.querySelectorAll("[data-perf-row]").length;
}

afterEach(cleanup);

describe("message row render cost (channel-switch mount)", () => {
  it(
    "[perf] ChatContent body tokenize+render scales with row count",
    () => {
      const small = messages(100, "c1");
      const big = messages(400, "c2");

      let t = performance.now();
      const r1 = render(
        <Wrap>{small.map((m) => <div data-perf-row key={m.id}><ChatContent event={m} /></div>)}</Wrap>,
      );
      const t100 = performance.now() - t;
      expect(rows(r1.container)).toBe(100);
      cleanup();

      t = performance.now();
      const r2 = render(
        <Wrap>{big.map((m) => <div data-perf-row key={m.id}><ChatContent event={m} /></div>)}</Wrap>,
      );
      const t400 = performance.now() - t;
      expect(rows(r2.container)).toBe(400);

      console.log(
        `[perf] ChatContent render: 100 bodies ${t100.toFixed(1)}ms · ` +
          `400 bodies ${t400.toFixed(1)}ms (${(t400 / Math.max(t100, 0.1)).toFixed(1)}× for 4× rows)`,
      );
      expect(t400).toBeLessThan(10_000);
    },
    30_000,
  );

  it(
    "[perf] full ChatMessage row (shell + body) scales with row count",
    () => {
      const small = messages(100, "m1");
      const big = messages(400, "m2");

      let t = performance.now();
      const r1 = render(
        <Wrap>
          {small.map((m) => (
            <div data-perf-row key={m.id}>
              <ChatMessage event={m} canWrite canModerate={false} />
            </div>
          ))}
        </Wrap>,
      );
      const t100 = performance.now() - t;
      expect(rows(r1.container)).toBe(100);
      cleanup();

      t = performance.now();
      const r2 = render(
        <Wrap>
          {big.map((m) => (
            <div data-perf-row key={m.id}>
              <ChatMessage event={m} canWrite canModerate={false} />
            </div>
          ))}
        </Wrap>,
      );
      const t400 = performance.now() - t;
      expect(rows(r2.container)).toBe(400);

      console.log(
        `[perf] ChatMessage render: 100 rows ${t100.toFixed(1)}ms · ` +
          `400 rows ${t400.toFixed(1)}ms (${(t400 / Math.max(t100, 0.1)).toFixed(1)}× for 4× rows) ` +
          `— compare foldTimeline: 2000 msgs ~2ms`,
      );
      expect(t400).toBeLessThan(20_000);
    },
    30_000,
  );
});
