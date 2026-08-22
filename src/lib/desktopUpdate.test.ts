import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import {
  downloadUrl,
  pickDesktopArtifact,
  selectDesktopRelease,
  toDesktopUpdate,
} from "./desktopUpdate";
import { parseRelease, type Release } from "./releases";

const HASH = "a".repeat(64);

function artifact(fields: Record<string, string>): string[] {
  return ["artifact", ...Object.entries(fields).map(([key, value]) => `${key} ${value}`)];
}

/** The artifact set CI publishes for a complete release, in event order. */
function allArtifacts(version: string): string[][] {
  const of = (filename: string, f: string, m = "application/octet-stream") =>
    artifact({
      url: `https://blossom.example/${HASH}${filename.slice(filename.lastIndexOf("."))}`,
      x: HASH,
      m,
      size: "1024",
      f,
      filename,
      alt: filename,
    });
  return [
    of(`Armada-${version}.AppImage`, "linux-x86_64", "application/vnd.appimage"),
    of(`Armada-${version}.deb`, "linux-x86_64", "application/vnd.debian.binary-package"),
    of(`Armada-${version}.flatpak`, "linux-x86_64", "application/vnd.flatpak"),
    of(`Armada-${version}.exe`, "windows-x86_64"),
    of(`Armada-${version}-portable.exe`, "windows-x86_64"),
    of(`Armada-${version}-mac-x64.zip`, "darwin-x86_64", "application/zip"),
    of(`Armada-${version}-mac-arm64.zip`, "darwin-aarch64", "application/zip"),
    of(`Armada-${version}.apk`, "android-arm64-v8a"),
  ];
}

/** The event shape as it comes off a relay socket. */
interface WireEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
}

function releaseEvent(
  secretKey: Uint8Array,
  {
    version,
    channel = "main",
    repoId = "armada",
    createdAt = 1_700_000_000,
    artifacts = allArtifacts(version),
  }: {
    version: string;
    channel?: string;
    repoId?: string;
    createdAt?: number;
    artifacts?: string[][];
  },
): WireEvent {
  const signed = finalizeEvent(
    {
      kind: 30622,
      created_at: createdAt,
      content: `notes for ${version}`,
      tags: [
        ["d", `${repoId}@${version}`],
        ["D", repoId],
        ["version", version],
        ["title", `Armada ${version}`],
        ["c", channel],
        ...artifacts,
      ],
    },
    secretKey,
  );
  // Round-trip through JSON, which is what a relay socket delivers — and not
  // only for fidelity. `finalizeEvent` marks the event verified on a symbol
  // property that `verifyEvent` then trusts without re-checking, and an object
  // spread would COPY that symbol onto a tampered event. A fixture built that
  // way asserts nothing about the signature. JSON cannot carry a symbol, so
  // every check below runs the real verification.
  return JSON.parse(JSON.stringify(signed)) as WireEvent;
}

function parsed(version: string): Release {
  const release = parseRelease(releaseEvent(generateSecretKey(), { version }));
  if (!release) throw new Error("fixture did not parse");
  return release;
}

describe("downloadUrl", () => {
  it("drops the extension from a Blossom URL so the installer keeps its name", () => {
    expect(downloadUrl(`https://blossom.example/${HASH}.AppImage`)).toBe(
      `https://blossom.example/${HASH}`,
    );
    expect(downloadUrl(`https://blossom.example/${HASH}.exe`)).toBe(
      `https://blossom.example/${HASH}`,
    );
  });

  it("leaves anything that is not a bare content address alone", () => {
    // A release published somewhere other than Blossom still has to resolve.
    expect(downloadUrl("https://files.example/downloads/Armada.AppImage")).toBe(
      "https://files.example/downloads/Armada.AppImage",
    );
    expect(downloadUrl(`https://blossom.example/${HASH}`)).toBe(
      `https://blossom.example/${HASH}`,
    );
    expect(downloadUrl("not a url")).toBe("not a url");
  });
});

describe("pickDesktopArtifact", () => {
  const release = parsed("v1.2.3");

  it("takes the AppImage on Linux, never the deb or Flatpak", () => {
    // Those two belong to apt and to the Flatpak remote; electron-updater must
    // not replace files behind a package manager.
    const picked = pickDesktopArtifact(release, { platform: "linux", arch: "x64" });
    expect(picked?.filename).toBe("Armada-v1.2.3.AppImage");
  });

  it("takes the NSIS installer on Windows, never the portable build", () => {
    // Both carry f=windows-x86_64 and the same mime type, so the filename is
    // the only thing that tells them apart.
    const picked = pickDesktopArtifact(release, { platform: "win32", arch: "x64" });
    expect(picked?.filename).toBe("Armada-v1.2.3.exe");
  });

  it("takes the zip matching the mac architecture", () => {
    expect(pickDesktopArtifact(release, { platform: "darwin", arch: "arm64" })?.filename).toBe(
      "Armada-v1.2.3-mac-arm64.zip",
    );
    expect(pickDesktopArtifact(release, { platform: "darwin", arch: "x64" })?.filename).toBe(
      "Armada-v1.2.3-mac-x64.zip",
    );
  });

  it("refuses an artifact that names a different architecture", () => {
    // No arm64 AppImage is built. Matching on the extension alone would hand
    // an x86_64 binary to an arm64 machine.
    expect(pickDesktopArtifact(release, { platform: "linux", arch: "arm64" })).toBeUndefined();
  });

  it("has nothing to offer a platform that does not self-update", () => {
    expect(pickDesktopArtifact(release, { platform: "android", arch: "arm64" })).toBeUndefined();
  });

  it("refuses an artifact with no checksum", () => {
    // `x` is the only thing the downloaded bytes get checked against, so an
    // artifact without one is not installable however well it matches.
    const unverifiable = parseRelease(
      releaseEvent(generateSecretKey(), {
        version: "v1.2.3",
        artifacts: [
          artifact({
            url: `https://blossom.example/${HASH}.AppImage`,
            f: "linux-x86_64",
            filename: "Armada-v1.2.3.AppImage",
          }),
        ],
      }),
    );
    expect(pickDesktopArtifact(unverifiable!, { platform: "linux", arch: "x64" })).toBeUndefined();
  });

  it("accepts an artifact whose platform token names no architecture", () => {
    const vague = parseRelease(
      releaseEvent(generateSecretKey(), {
        version: "v1.2.3",
        artifacts: [
          artifact({
            url: `https://blossom.example/${HASH}.AppImage`,
            x: HASH,
            f: "linux",
            filename: "Armada-v1.2.3.AppImage",
          }),
        ],
      }),
    );
    expect(pickDesktopArtifact(vague!, { platform: "linux", arch: "x64" })?.filename).toBe(
      "Armada-v1.2.3.AppImage",
    );
  });
});

describe("toDesktopUpdate", () => {
  it("reports a semver version and carries both digests", () => {
    const release = parsed("v1.2.3");
    const artifact = pickDesktopArtifact(release, { platform: "linux", arch: "x64" })!;
    const update = toDesktopUpdate(release, artifact);

    // electron-updater compares with semver, which the tag's leading v is not.
    expect(update.version).toBe("1.2.3");
    expect(update.tag).toBe("v1.2.3");
    expect(update.file.filename).toBe("Armada-v1.2.3.AppImage");
    expect(update.file.url).toBe(`https://blossom.example/${HASH}`);
    // The `x` sha256 is both the content address and the digest the download
    // is verified against. There is no second hash to keep in step with it.
    expect(update.file.sha256).toBe(HASH);
    expect(update.releaseDate).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
});

describe("selectDesktopRelease", () => {
  const secretKey = generateSecretKey();
  const author = getPublicKey(secretKey);
  const target = { platform: "linux", arch: "x64" };
  const select = (events: unknown[], overrides = {}) =>
    selectDesktopRelease(events, { target, authors: [author], ...overrides });

  it("offers the newest stable release", () => {
    const events = [
      releaseEvent(secretKey, { version: "v1.2.3", createdAt: 1000 }),
      releaseEvent(secretKey, { version: "v1.3.0", createdAt: 2000 }),
      releaseEvent(secretKey, { version: "v1.1.0", createdAt: 500 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("passes over a prerelease unless the running build is one", () => {
    const events = [
      releaseEvent(secretKey, { version: "v1.3.0", createdAt: 2000 }),
      releaseEvent(secretKey, { version: "v1.4.0-rc.1", channel: "rc", createdAt: 3000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
    expect(select(events, { allowPrerelease: true })?.version).toBe("1.4.0-rc.1");
  });

  it("falls back to an older release when the newest has no artifact for us", () => {
    // A tag whose Windows job failed still publishes an event. Offering
    // nothing would strand Windows until the next release.
    const events = [
      releaseEvent(secretKey, { version: "v1.3.0", createdAt: 2000 }),
      releaseEvent(secretKey, {
        version: "v1.4.0",
        createdAt: 3000,
        artifacts: [
          artifact({
            url: `https://blossom.example/${HASH}.AppImage`,
            x: HASH,
            f: "linux-x86_64",
            filename: "Armada-v1.4.0.AppImage",
          }),
        ],
      }),
    ];
    expect(select(events, { target: { platform: "win32", arch: "x64" } })?.version).toBe("1.3.0");
    expect(select(events)?.version).toBe("1.4.0");
  });

  it("rejects an event whose signature does not verify", () => {
    // The relay is untrusted transport, and the payload is a binary this
    // process is about to download and execute.
    const forged = { ...releaseEvent(secretKey, { version: "v9.9.9" }), sig: "0".repeat(128) };
    const genuine = releaseEvent(secretKey, { version: "v1.3.0" });
    expect(select([forged, genuine])?.version).toBe("1.3.0");
  });

  it("rejects a validly signed release from an unpinned author", () => {
    const stranger = generateSecretKey();
    const events = [
      releaseEvent(stranger, { version: "v9.9.9", createdAt: 9000 }),
      releaseEvent(secretKey, { version: "v1.3.0", createdAt: 2000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("rejects a release of a different repository by the same author", () => {
    const events = [
      releaseEvent(secretKey, { version: "v9.9.9", repoId: "something-else", createdAt: 9000 }),
      releaseEvent(secretKey, { version: "v1.3.0", createdAt: 2000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("ignores events of another kind and malformed payloads", () => {
    const notARelease = finalizeEvent(
      { kind: 1, created_at: 9000, content: "hello", tags: [] },
      secretKey,
    );
    const events = [notARelease, null, "nonsense", { kind: 30622 }, releaseEvent(secretKey, { version: "v1.3.0" })];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("keeps the newest event when a version is republished", () => {
    const first = releaseEvent(secretKey, { version: "v1.3.0", createdAt: 1000 });
    const corrected = releaseEvent(secretKey, {
      version: "v1.3.0",
      createdAt: 5000,
      artifacts: [
        artifact({
          url: `https://blossom.example/${"b".repeat(64)}.AppImage`,
          x: "b".repeat(64),
          f: "linux-x86_64",
          filename: "Armada-v1.3.0.AppImage",
        }),
      ],
    });
    expect(select([first, corrected])?.file.sha256).toBe("b".repeat(64));
  });

  it("returns undefined when nothing matches", () => {
    expect(select([])).toBeUndefined();
  });

  it("matches authors case-insensitively", () => {
    const events = [releaseEvent(secretKey, { version: "v1.3.0" })];
    expect(select(events, { authors: [author.toUpperCase()] })?.version).toBe("1.3.0");
  });

  it("uses the pubkey the secret key actually derives", () => {
    // Guards the fixture itself: every author check above is meaningless if
    // the events are signed by a key unrelated to `author`.
    expect(bytesToHex(secretKey)).toHaveLength(64);
    expect(releaseEvent(secretKey, { version: "v1.0.0" }).pubkey).toBe(author);
  });
});
