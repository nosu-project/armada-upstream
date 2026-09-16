/**
 * The signup profile step publishes a kind 0 for an account that is seconds
 * old, which is the one publish in the app with no previous version to merge
 * with and no way to notice it went to the wrong place. The tests here pin the
 * three things that makes load-bearing: it signs only for the key signup just
 * minted, a preset costs exactly one upload however many were tried, and
 * leaving without saying anything says nothing.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // The presets are read back out of the bundle so what lands in the event is
  // a Blossom URL, not a path on this deployment.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))),
  );
});

describe("signup profile step", () => {
  it("uploads a chosen preset once, however many were tried", async () => {
    const onFinish = vi.fn();
    renderStep({ expectedPubkey: PUBKEY, onFinish });

    fireEvent.change(screen.getByPlaceholderText("Your name"), { target: { value: "  Ana  " } });
    // Trying three of them must not cost three uploads: the bytes are only
    // fetched and pushed for whichever one is still chosen at Continue.
    fireEvent.click(screen.getByRole("button", { name: "Cat" }));
    fireEvent.click(screen.getByRole("button", { name: "Fox" }));
    fireEvent.click(screen.getByRole("button", { name: "Ghost" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.uploadFile.mock.calls[0][0].name).toBe("ghost.png");

    const published = h.publishEvent.mock.calls[0][0];
    expect(published.kind).toBe(0);
    expect(JSON.parse(published.content)).toEqual({
      name: "Ana",
      picture: "https://blossom.example/abc",
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
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
