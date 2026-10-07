import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchProfile } from "@/hooks/useSearchProfiles";

const toast = vi.fn();
vi.mock("@/hooks/useToast", () => ({ toast: (...args: unknown[]) => toast(...args) }));

let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;
vi.mock("@/concord/hooks/useInvites", () => ({
  useInviteActions: () => ({
    createLink: vi.fn(),
    revokeLink: vi.fn(),
    myLinks: [],
    isSendingInvite: false,
    isPublic: false,
    revokeWouldPrivatize: () => false,
    sendDirectInvite: () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  }),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

const ana: SearchProfile = {
  pubkey: "a".repeat(64),
  metadata: { name: "Ana" },
  event: { id: "", kind: 0, pubkey: "a".repeat(64), content: "", created_at: 0, tags: [] },
};
vi.mock("@/components/chat/ProfileSearchSelect", () => ({
  ProfileSearchSelect: ({ onSelect }: { onSelect: (p: SearchProfile) => void }) => (
    <button type="button" onClick={() => onSelect(ana)}>
      pick ana
    </button>
  ),
}));

import { InviteDialog } from "./InviteDialog";

function renderDialog() {
  const view = render(<InviteDialog community={undefined} open onOpenChange={() => {}} canCreateLink={false} />);
  fireEvent.click(screen.getByText("pick ana"));
  return view;
}

describe("InviteDialog direct invite", () => {
  beforeEach(() => {
    toast.mockClear();
    settle = undefined;
  });

  it("confirms a send that lands while the dialog is open", async () => {
    renderDialog();
    await act(async () => settle!.resolve());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Invite sent" }));
  });

  it("stays quiet about a send that lands after the dialog closed", async () => {
    const view = renderDialog();
    view.rerender(<InviteDialog community={undefined} open={false} onOpenChange={() => {}} canCreateLink={false} />);
    await act(async () => settle!.resolve());
    expect(toast).not.toHaveBeenCalled();
  });

  it("still reports a send that fails after the dialog closed", async () => {
    const view = renderDialog();
    view.rerender(<InviteDialog community={undefined} open={false} onOpenChange={() => {}} canCreateLink={false} />);
    await act(async () => settle!.reject(new Error("No relay accepted the invite.")));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't invite Ana", variant: "destructive" }),
    );
  });
});
