import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RoleEditor } from "@/concord/components/RolesView";
import type { Role } from "@/concord/lib/roles";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

const LIVE = "11".repeat(32);
const GONE = "22".repeat(32);

const role = (over: Partial<Role> = {}): Role => ({
  roleId: "role-1",
  name: "Helpers",
  position: 3,
  permissions: 0n,
  scope: { kind: "server" },
  color: 0,
  ...over,
});

function setup(r: Role) {
  const onSave = vi.fn();
  render(
    <RoleEditor
      role={r}
      // What RolesView hands over: live channels only, deleted ones filtered.
      channels={[{ idHex: LIVE, name: "general" }]}
      holders={0}
      saving={false}
      error={null}
      canRevoke={false}
      onSave={onSave}
      onRevoke={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  return { onSave };
}

describe("RoleEditor scope picker", () => {
  it("names a deleted scope without offering it as a channel", () => {
    setup(role({ scope: { kind: "channel", channelId: GONE } }));
    expect(screen.getByRole("combobox")).toHaveTextContent("A deleted channel");
    expect(screen.queryByText(/deleted-channel|# ?deleted channel/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has been deleted\. Saving keeps the role as it is/)).toBeInTheDocument();
  });

  it("writes a deleted channel scope back unchanged on save", () => {
    // Hiding the channel from the picker must not rescope the role: the
    // scope is the data, and a save that silently widened it to the whole
    // community would change what every member's client folds.
    const { onSave } = setup(role({ scope: { kind: "channel", channelId: GONE } }));
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Renamed" } });
    fireEvent.submit(screen.getByLabelText("Role name").closest("form")!);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "Renamed",
      scope: { kind: "channel", channelId: GONE },
    });
  });

  it("shows a live channel scope by name", () => {
    setup(role({ scope: { kind: "channel", channelId: LIVE } }));
    expect(screen.getByRole("combobox")).toHaveTextContent("general");
    expect(screen.queryByText("A deleted channel")).not.toBeInTheDocument();
  });
});
