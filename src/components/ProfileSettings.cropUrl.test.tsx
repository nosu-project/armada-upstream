import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileSettings } from "@/components/ProfileSettings";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUserProfile: () => ({
    user: { pubkey: "a".repeat(64) },
    metadata: undefined,
    event: undefined,
    imeta: undefined,
  }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useUploadFile", () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useUploadProfileImage", () => ({
  useUploadProfileImage: () => ({ upload: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/imageMetadata", () => ({
  METADATA_SCAN_BYTES: 16,
  isAnimatedImage: () => false,
}));
vi.mock("@/components/ProfileCard", () => ({
  ProfileCard: ({ onPickImage }: { onPickImage: (f: "picture") => void }) => (
    <button type="button" onClick={() => onPickImage("picture")}>pick</button>
  ),
}));
vi.mock("@/components/ImageCropDialog", () => ({
  ImageCropDialog: ({ imageSrc, onCancel }: { imageSrc: string; onCancel: () => void }) => (
    <div data-testid="crop" data-src={imageSrc}>
      <button type="button" onClick={onCancel}>cancel</button>
    </div>
  ),
}));
vi.mock("@/components/PaymentTargetsEditor", () => ({
  PaymentTargetsEditor: () => null,
}));

let counter = 0;
function stubObjectUrls() {
  const created = new Set<string>();
  const revoked = new Set<string>();
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++counter}`;
    created.add(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.add(url); });
  return { created, revoked };
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileSettings />
    </QueryClientProvider>,
  );
}

async function chooseImage(container: HTMLElement) {
  const input = container.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
  const file = new File([new Uint8Array(32)], "a.png", { type: "image/png" });
  Object.defineProperty(file, "slice", {
    value: () => ({ arrayBuffer: async () => new ArrayBuffer(16) }),
  });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  return screen.findByTestId("crop");
}

afterEach(() => vi.restoreAllMocks());

describe("ProfileSettings crop object URL", () => {
  it("revokes the URL when the dialog is cancelled", async () => {
    const { created, revoked } = stubObjectUrls();
    const view = mount();
    await chooseImage(view.container);
    fireEvent.click(screen.getByText("cancel"));
    expect(created.size).toBe(1);
    expect([...created].every((u) => revoked.has(u))).toBe(true);
    view.unmount();
  });

  it("revokes the URL when unmounted with the dialog open", async () => {
    const { created, revoked } = stubObjectUrls();
    const view = mount();
    const src = (await chooseImage(view.container)).getAttribute("data-src")!;
    expect(created.has(src)).toBe(true);
    expect(revoked.has(src)).toBe(false);
    view.unmount();
    expect(revoked.has(src)).toBe(true);
  });
});
