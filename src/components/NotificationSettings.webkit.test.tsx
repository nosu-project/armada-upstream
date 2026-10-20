import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useNativeNotifications", () => ({
  useNativeNotifications: () => ({ supported: false }),
}));
vi.mock("@/contexts/WebPushContext", () => ({
  useWebPushNotifications: () => ({ supported: false, unavailableReason: "webkit" }),
}));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isIOS: () => true,
}));

import { NotificationSettings } from "@/components/NotificationSettings";

describe("NotificationSettings on WebKit", () => {
  it("explains that the iOS web app has no background notifications", () => {
    render(<NotificationSettings />);
    expect(screen.getByText(/aren't available in the iPhone and iPad web app/)).toBeInTheDocument();
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();
  });
});
