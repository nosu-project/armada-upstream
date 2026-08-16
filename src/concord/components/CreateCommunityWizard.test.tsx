/**
 * The community-creation wizard.
 *
 * What these lock down is the shape the cramped modal could not have: the
 * founding answers and the community's presentation are collected across two
 * steps, and NOTHING is published until the last button — so an abandoned
 * wizard leaves no half-made community, and the icon/banner/description reach
 * the genesis metadata in the same `create` call as the name.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateCommunityWizard } from "@/concord/components/CreateCommunityWizard";
import { ownAvServers } from "@/concord/hooks/useVoice";

import type { ReactNode } from "react";

/** Mirrors `create`'s input, so the call assertions below are type-checked. */
interface CreateArg {
  name: string;
  relays?: string[];
  avBrokers?: string[];
  messageExpirationSecs?: number;
  description?: string;
  icon?: { url: string; key: string; nonce: string; hash: string };
  banner?: { url: string; key: string; nonce: string; hash: string };
}

const h = vi.hoisted(() => ({
  create: vi.fn(async (_arg: CreateArg) => ({ communityId: "ab".repeat(32), name: "Fleet" })),
  navigate: vi.fn(),
  uploads: 0,
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));

// The real shell is a fixed-position takeover with a live ASCII canvas in it;
// none of that is what these tests are about (see LoginSetup.test.tsx).
vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/RelayListEditor", () => ({
  RelayListEditor: () => <div>relay editor</div>,
}));

// Stands in for react-easy-crop: exposes the one affordance the flow needs.
vi.mock("@/components/ImageCropDialog", () => ({
  ImageCropDialog: ({ title, onCrop }: { title: string; onCrop: (b: Blob) => void }) => (
    <button type="button" onClick={() => onCrop(new Blob(["cropped"]))}>
      confirm {title}
    </button>
  ),
}));

vi.mock("@/concord/lib/image", () => ({
  encryptImageBlob: async () => ({
    ciphertext: new Uint8Array([1, 2, 3]),
    key: "aa".repeat(32),
    nonce: "bb".repeat(16),
    hash: "cc".repeat(32),
  }),
}));

vi.mock("@/concord/hooks/useCommunityActions", () => ({
  useCommunityActions: () => ({ create: h.create, isCreating: false }),
  useCreateRelayCandidates: () => ["wss://relay.test"],
}));

vi.mock("@/hooks/useUploadFile", () => ({
  useUploadFile: () => ({
    mutateAsync: async () => [["url", `https://blossom.test/${++h.uploads}.enc`]],
  }),
}));

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

beforeEach(() => {
  h.create.mockClear();
  h.navigate.mockClear();
  h.uploads = 0;
  // jsdom ships neither.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

/** Fill in the name and cross into the presentation step. */
function nameAndContinue(name = "Fleet") {
  fireEvent.change(screen.getByLabelText("Community name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

/** Cross the presentation step and the relay step, onto the one that creates. */
function leaveLookStep() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

/** Pick an image for a slot: open it, hand the input a file, confirm the crop. */
async function pickImage(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `Add ${label}` }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["raw"], `${label}.png`, { type: "image/png" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`confirm crop ${label}`, "i") }));
  // The upload is awaited inside the handler; the slot flips to "Change" after.
  await screen.findByRole("button", { name: `Change ${label}` });
}

const createButton = () => screen.getByRole("button", { name: /create encrypted community/i });

describe("CreateCommunityWizard", () => {
  it("publishes nothing from the naming step, then creates once with both steps' answers", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    nameAndContinue();

    // Advancing is not creating: the old dialog's single button did both.
    expect(h.create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Community description"), {
      target: { value: "Ships and sailors." },
    });
    leaveLookStep();

    // Still nothing — the relay and retention decisions come first.
    expect(h.create).not.toHaveBeenCalled();

    fireEvent.click(createButton());

    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create.mock.calls[0][0]).toMatchObject({
      name: "Fleet",
      description: "Ships and sailors.",
      relays: ["wss://relay.test"],
    });
  });

  it("carries an icon and a banner into that same create, as sealed pointers", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    nameAndContinue();
    await pickImage("banner");
    await pickImage("icon");
    leaveLookStep();

    fireEvent.click(createButton());

    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    const arg = h.create.mock.calls[0][0];
    // The blob the media host got is ciphertext; the key rides the metadata.
    expect(arg.icon).toMatchObject({ key: "aa".repeat(32), hash: "cc".repeat(32) });
    expect(arg.icon?.url).toBe("https://blossom.test/2.enc");
    expect(arg.banner?.url).toBe("https://blossom.test/1.enc");
  });

  it("leaves the presentation fields out when the second step is skipped", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    nameAndContinue();
    leaveLookStep();
    fireEvent.click(createButton());

    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create.mock.calls[0][0]).toMatchObject({
      name: "Fleet",
      description: undefined,
      icon: undefined,
      banner: undefined,
    });
  });

  /**
   * Retention and relays used to sit under the name field — the relay list
   * behind a chevron fused to the submit button. Each has its own step now, and
   * they are two steps rather than one because stacked they ran past the bottom
   * of a phone and took the create button with them.
   */
  it("gives both lists one step and the timer another, ending on the short one", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    nameAndContinue();
    expect(screen.queryByText("relay editor")).not.toBeInTheDocument();

    // Where it lives: relays and voice servers together, both shown outright
    // rather than folded away behind a disclosure.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("where it lives")).toBeInTheDocument();
    expect(screen.getByText("relay editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Add voice server")).toBeInTheDocument();
    expect(screen.queryByLabelText("Disappearing messages timer")).not.toBeInTheDocument();

    // The timer is alone with the create button, so nothing can push it off.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Disappearing messages timer")).toBeInTheDocument();
    expect(screen.queryByText("relay editor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add voice server")).not.toBeInTheDocument();

    fireEvent.click(createButton());
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    // The default carries even when the picker is never touched.
    expect(h.create.mock.calls[0][0].messageExpirationSecs).toBeGreaterThan(0);
  });

  /** Onto "where it lives", where both lists are edited. */
  function reachTheListsStep() {
    nameAndContinue();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("carries the voice servers the step showed into create, prefilled with the creator's own", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);
    reachTheListsStep();

    // Prefilled — this list is what the community would otherwise have been
    // minted with without anyone being shown it.
    const prefilled = ownAvServers()[0].replace(/^https:\/\//, "");
    expect(screen.getByText(prefilled)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Add voice server"), { target: { value: "voice.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    // A bare host arrives as the canonical https origin CORD-07 §5 hashes.
    expect(h.create.mock.calls[0][0].avBrokers).toEqual([
      ownAvServers()[0],
      "https://voice.example.com",
    ]);
  });

  it("mints no voice servers at all when the list is emptied", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);
    reachTheListsStep();

    for (const origin of ownAvServers()) {
      fireEvent.click(screen.getByRole("button", { name: `Remove ${origin}` }));
    }
    expect(screen.getByText(/members will use their own/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(createButton());
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    // Explicitly empty, not absent: members then use their own servers, and
    // `create` must not substitute the creator's back in.
    expect(h.create.mock.calls[0][0].avBrokers).toEqual([]);
  });

  it("refuses an unusable voice address instead of adding it", () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);
    reachTheListsStep();

    fireEvent.change(screen.getByLabelText("Add voice server"), { target: { value: "http://insecure.example" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.queryByText("insecure.example")).not.toBeInTheDocument();
  });

  it("will not advance without a name", () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("refuses a name past the protocol's 64-byte cap instead of throwing at publish", () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    // 65 bytes: buildMetadataEdition would reject this deep inside create.
    fireEvent.change(screen.getByLabelText("Community name"), { target: { value: "x".repeat(65) } });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByText(/capped at 64 bytes/i)).toBeInTheDocument();
  });

  it("lands on the new community, replacing the wizard in history", async () => {
    render(<CreateCommunityWizard onClose={vi.fn()} />);

    nameAndContinue();
    leaveLookStep();
    fireEvent.click(createButton());

    // Pushed, going back would re-show a filled-in wizard whose button mints a
    // second community.
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith(`/c/${"ab".repeat(32)}`, { replace: true }),
    );
  });
});
