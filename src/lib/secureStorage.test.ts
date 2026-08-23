// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secureStorage } from "@/lib/secureStorage";

// The desktop/web paths are what this file covers, so Capacitor reports web.
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "web",
    isPluginAvailable: () => false,
    isNativePlatform: () => false,
  },
}));

vi.mock("capacitor-secure-storage-plugin", () => ({
  SecureStoragePlugin: {
    get: vi.fn(async () => {
      throw new Error("not native");
    }),
    set: vi.fn(async () => {}),
  },
}));

const KEY = "armada:login";
const LOCKED = "armada:login-locked";
const LOGINS = JSON.stringify([{ type: "nsec", pubkey: "ab".repeat(32), nsec: "nsec1test" }]);

/**
 * A stand-in for Electron safeStorage. It encodes rather than merely wrapping,
 * so "the stored blob does not contain the nsec" is an assertion about the
 * adapter storing cipher output — not about the shape of this stub.
 */
function fakeCipher() {
  return {
    encrypt: (plaintext: string) => `ENC:${btoa(plaintext)}`,
    decrypt: (blob: string) => (blob.startsWith("ENC:") ? atob(blob.slice(4)) : null),
  };
}

interface BridgeOptions {
  /** Omit the secret methods entirely — a shell older than this feature. */
  legacyShell?: boolean;
  /** Simulate an unavailable credential store (encrypt/decrypt yield null). */
  unavailable?: boolean;
  /** Force every decrypt to fail, as a reset keyring would. */
  decryptFails?: boolean;
}

function installDesktopBridge(options: BridgeOptions = {}) {
  const cipher = fakeCipher();
  const bridge: Record<string, unknown> = {
    isDesktop: true,
    setBadge: vi.fn(),
    getInfo: vi.fn(),
    getScreenSources: vi.fn(),
    onPickScreenSource: vi.fn(),
    getMicAccessStatus: vi.fn(),
    openMicPrivacySettings: vi.fn(),
  };

  if (!options.legacyShell) {
    bridge.getSecretsStatus = vi.fn(async () => ({
      available: !options.unavailable,
      backend: options.unavailable ? "unknown" : "gnome_libsecret",
    }));
    bridge.encryptSecret = vi.fn(async (plaintext: string) =>
      options.unavailable ? null : cipher.encrypt(plaintext),
    );
    bridge.decryptSecret = vi.fn(async (blob: string) =>
      options.unavailable || options.decryptFails ? null : cipher.decrypt(blob),
    );
  }

  // @ts-expect-error — installing the shell bridge the preload would inject.
  window.armadaDesktop = bridge;
  return { bridge, cipher };
}

/** Read the raw stored string, bypassing the adapter. */
const rawStored = (key = KEY) => localStorage.getItem(key);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as { armadaDesktop?: unknown }).armadaDesktop;
  localStorage.clear();
});

describe("secureStorage on the web (no desktop bridge)", () => {
  it("stores and reads the login list as plaintext", async () => {
    await secureStorage.setItem(KEY, LOGINS);
    expect(rawStored()).toBe(LOGINS);
    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
  });

  it("returns null for an absent key", async () => {
    await expect(secureStorage.getItem(KEY)).resolves.toBeNull();
  });
});

describe("secureStorage in the desktop shell", () => {
  it("encrypts a non-empty login list at rest", async () => {
    installDesktopBridge();
    await secureStorage.setItem(KEY, LOGINS);

    const stored = rawStored();
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("nsec1test");
    expect(JSON.parse(stored!)).toMatchObject({ v: 1, enc: "safeStorage" });
  });

  it("round-trips the value through the envelope", async () => {
    installDesktopBridge();
    await secureStorage.setItem(KEY, LOGINS);
    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
  });

  it("keeps an empty list as literal plaintext for the boot splash", async () => {
    installDesktopBridge();
    await secureStorage.setItem(KEY, "[]");

    // index.html reads this synchronously and tests `!== "[]"` to decide
    // whether to draw the crest; an envelope would read as "signed in".
    expect(rawStored()).toBe("[]");
    await expect(secureStorage.getItem(KEY)).resolves.toBe("[]");
  });

  it("migrates a legacy plaintext list to the envelope on first read", async () => {
    installDesktopBridge();
    localStorage.setItem(KEY, LOGINS);

    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
    expect(rawStored()).not.toContain("nsec1test");
    expect(JSON.parse(rawStored()!)).toMatchObject({ enc: "safeStorage" });
  });

  it("does not wrap a legacy empty list", async () => {
    installDesktopBridge();
    localStorage.setItem(KEY, "[]");

    await expect(secureStorage.getItem(KEY)).resolves.toBe("[]");
    expect(rawStored()).toBe("[]");
  });

  it("returns null for an absent key", async () => {
    installDesktopBridge();
    await expect(secureStorage.getItem(KEY)).resolves.toBeNull();
  });
});

describe("secureStorage when the credential store is unavailable", () => {
  it("writes plaintext rather than failing the login write", async () => {
    installDesktopBridge({ unavailable: true });
    await secureStorage.setItem(KEY, LOGINS);

    expect(rawStored()).toBe(LOGINS);
    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
  });

  it("leaves a legacy plaintext list alone instead of half-migrating", async () => {
    installDesktopBridge({ unavailable: true });
    localStorage.setItem(KEY, LOGINS);

    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
    expect(rawStored()).toBe(LOGINS);
  });

  it("falls back to plaintext in a shell that predates the bridge methods", async () => {
    installDesktopBridge({ legacyShell: true });
    await secureStorage.setItem(KEY, LOGINS);

    expect(rawStored()).toBe(LOGINS);
    await expect(secureStorage.getItem(KEY)).resolves.toBe(LOGINS);
  });
});

describe("secureStorage when the stored blob can't be decrypted", () => {
  it("reports signed-out without destroying the blob", async () => {
    const { cipher } = installDesktopBridge();
    const envelope = JSON.stringify({
      v: 1,
      enc: "safeStorage",
      data: cipher.encrypt(LOGINS),
    });
    localStorage.setItem(KEY, envelope);

    installDesktopBridge({ decryptFails: true });

    // "Locked", not "empty".
    await expect(secureStorage.getItem(KEY)).resolves.toBeNull();
    // The original is untouched, and a copy is parked out of the way of the
    // next write — it is very likely the only copy of the identity key.
    expect(rawStored()).toBe(envelope);
    expect(rawStored(LOCKED)).toBe(envelope);
  });

  it("survives a fresh login overwriting the unreadable blob", async () => {
    const { cipher } = installDesktopBridge();
    const envelope = JSON.stringify({
      v: 1,
      enc: "safeStorage",
      data: cipher.encrypt(LOGINS),
    });
    localStorage.setItem(KEY, envelope);
    installDesktopBridge({ decryptFails: true });
    await secureStorage.getItem(KEY);

    // The user logs in again; the old key survives under the parked copy.
    await secureStorage.setItem(KEY, JSON.stringify([{ type: "nsec", nsec: "nsec1other" }]));
    expect(rawStored(LOCKED)).toBe(envelope);
  });

  it("keeps the first parked copy rather than clobbering it", async () => {
    const { cipher } = installDesktopBridge();
    const first = JSON.stringify({ v: 1, enc: "safeStorage", data: cipher.encrypt(LOGINS) });
    localStorage.setItem(KEY, first);
    installDesktopBridge({ decryptFails: true });

    await secureStorage.getItem(KEY);
    const second = JSON.stringify({ v: 1, enc: "safeStorage", data: "ENC:bGF0ZXI=" });
    localStorage.setItem(KEY, second);
    await secureStorage.getItem(KEY);

    expect(rawStored(LOCKED)).toBe(first);
  });
});
