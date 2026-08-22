import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetNotificationSettingsAuthorityForTests,
  markNotificationSettingsReady,
  notificationPolicyIsAuthoritative,
  notificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("notification settings authority", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetNotificationSettingsAuthorityForTests();
  });

  afterEach(() => {
    localStorage.clear();
    _resetNotificationSettingsAuthorityForTests();
  });

  it("uses sync-off config as session authority without manufacturing a durable proof", () => {
    expect(notificationPolicyIsAuthoritative(false, false)).toBe(true);
    expect(notificationPolicyIsAuthoritative(false, true)).toBe(false);
    expect(notificationSettingsReady(A)).toBe(false);
  });

  it("is account-scoped and does not treat a fresh account's defaults as ready", () => {
    expect(notificationSettingsReady(A)).toBe(false);
    markNotificationSettingsReady(A);
    expect(notificationSettingsReady(A)).toBe(true);
    expect(notificationSettingsReady(B)).toBe(false);
  });

  it("retains a distinguishable trusted last-good snapshot across reload", () => {
    markNotificationSettingsReady(A);
    _resetNotificationSettingsAuthorityForTests();
    expect(notificationSettingsReady(A)).toBe(true);
  });
});
