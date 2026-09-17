/**
 * The signup profile step publishes a kind 0 for an account that is seconds
 * old, which is the one publish in the app with no previous version to merge
 * with and no way to notice it went to the wrong place. The tests here pin the
 * three things that makes load-bearing: it signs only for the key signup just
 * minted, a preset is published as the Blossom URL it already has rather than
 * copied, and leaving without saying anything says nothing. Two more are about
 * the presets themselves: every one of them is such a URL — none of this
 * artwork is in the bundle or the repository — and the submitted ones lead the
 * grid with their artist credited in the label, where the hover tooltip is the
 * only place that credit is legible.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  publishEvent: vi.fn<(template: { kind: number; content: string; tags: string[][] }) => Promise<void>>(
    async () => undefined,
  ),
  uploadFile: vi.fn<(file: File) => Promise<string[][]>>(async () => [
    ["url", "https://blossom.example/abc"],
  ]),
  toast: vi.fn(),
  user: undefined as { pubkey: string } | undefined,
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publishEvent }),
}));
vi.mock("@/hooks/useUploadFile", () => ({
  useUploadFile: () => ({ mutateAsync: h.uploadFile, isPending: false }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/lib/haptics", () => ({ impact: vi.fn() }));

import { ProfileStepBody } from "@/components/onboarding/ProfileStep";
import { DEFAULT_AVATARS } from "@/lib/defaultAvatars";

const PUBKEY = "a".repeat(64);

function renderStep(props: { expectedPubkey?: string; onFinish: () => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <ProfileStepBody expectedPubkey={props.expectedPubkey} onFinish={props.onFinish} />,
    { wrapper },
  );
}

beforeEach(() => {
  h.publishEvent.mockClear();
  h.uploadFile.mockClear();
  h.toast.mockClear();
  h.user = { pubkey: PUBKEY };
  // Nothing here may reach the network: a preset is published by URL, so the
  // step never fetches a picture and never uploads one.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the profile step fetched a picture");
    }),
  );
});

describe("signup profile step", () => {
  it("publishes the preset's own URL, uploading nothing however many were tried", async () => {
    // Every preset is already a blob on a Blossom server at a content
    // addressed URL. Copying one at signup would put a second copy of it on
    // whatever server this account happens to be pointed at, under a URL that
    // no longer says which picture it is — and trying three would have cost
    // three of them.
    const onFinish = vi.fn();
    renderStep({ expectedPubkey: PUBKEY, onFinish });

    const cat = DEFAULT_AVATARS.find((avatar) => avatar.id === "cat");
    fireEvent.change(screen.getByPlaceholderText("Your name"), { target: { value: "  Ana  " } });
    fireEvent.click(screen.getByRole("button", { name: "Fox" }));
    fireEvent.click(screen.getByRole("button", { name: "Dragon by gravestoneghost" }));
    fireEvent.click(screen.getByRole("button", { name: "Cat" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
    expect(h.uploadFile).not.toHaveBeenCalled();

    const published = h.publishEvent.mock.calls[0][0];
    expect(published.kind).toBe(0);
    expect(JSON.parse(published.content)).toEqual({ name: "Ana", picture: cat?.url });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("offers nothing but Blossom URLs, submitted artwork first", async () => {
    // A preset that were a path in this build would be a `picture` that works
    // in Armada and nowhere else — on the native builds the origin is
    // `capacitor://localhost`, which resolves for nobody but the device that
    // wrote it. So none of these pictures is in the bundle or the repository,
    // and the credited rows lead, putting the work somebody submitted in front
    // of the placeholders still waiting to be replaced.
    renderStep({ expectedPubkey: PUBKEY, onFinish: vi.fn() });

    for (const avatar of DEFAULT_AVATARS) {
      expect(avatar.url).toMatch(/^https:\/\/[^/]+\/[0-9a-f]{64}\.\w+$/);
      expect(screen.getByRole("button", { name: avatar.label })).toBeInTheDocument();
    }

    const credited = DEFAULT_AVATARS.filter((avatar) => / by /.test(avatar.label));
    expect(DEFAULT_AVATARS.slice(0, credited.length)).toEqual(credited);
    expect(credited.map((avatar) => avatar.label)).toEqual([
      "Banana King by Aiden J arts",
      "Toucan by eempo",
      "Skull by Julian Cela",
      "Dragon by gravestoneghost",
    ]);
  });

  it("offers a dozen and no more", async () => {
    // The grid is one screenful of choices, so a new picture displaces a
    // placeholder rather than joining it. Without this the list only ever
    // grows, a submission at a time, and nobody notices until the step
    // scrolls.
    expect(DEFAULT_AVATARS).toHaveLength(12);
    expect(new Set(DEFAULT_AVATARS.map((avatar) => avatar.id)).size).toBe(12);
  });

  it("shows the artist's name when a preset is hovered for a moment", async () => {
    // The credit for a submitted avatar is carried by the label and rendered
    // nowhere, so the tooltip is the only way to read it without a screen
    // reader. It has to wait for the delay: appearing instantly would put a
    // popover under the pointer every time it crossed the grid.
    vi.useFakeTimers();
    try {
      renderStep({ expectedPubkey: PUBKEY, onFinish: vi.fn() });
      const preset = screen.getByRole("button", { name: "Dragon by gravestoneghost" });

      fireEvent.pointerMove(preset, { pointerType: "mouse" });
      expect(screen.queryByRole("tooltip")).toBeNull();

      act(() => void vi.advanceTimersByTime(600));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Dragon by gravestoneghost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to sign when the active account is not the one signup created", async () => {
    // The signer is whoever is logged in. If the new login is not the active
    // one, publishing here would replace a real person's profile.
    h.user = { pubkey: "b".repeat(64) };
    const onFinish = vi.fn();
    renderStep({ expectedPubkey: PUBKEY, onFinish });

    fireEvent.change(screen.getByPlaceholderText("Your name"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(h.publishEvent).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalled();
  });

  it("publishes nothing when there is nothing to publish", async () => {
    const onFinish = vi.fn();
    renderStep({ expectedPubkey: PUBKEY, onFinish });

    // Continue with an empty form is a skip, not an empty kind 0 — which would
    // be a profile event that erases nothing and says nothing.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(h.publishEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onFinish).toHaveBeenCalledTimes(2);
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it("still leaves the step when the publish fails", async () => {
    // The account exists either way and both fields live in Settings forever
    // after; being stuck on this screen is the worse outcome.
    h.publishEvent.mockRejectedValueOnce(new Error("no relays"));
    const onFinish = vi.fn();
    renderStep({ expectedPubkey: PUBKEY, onFinish });

    fireEvent.change(screen.getByPlaceholderText("Your name"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalled();
  });
});
