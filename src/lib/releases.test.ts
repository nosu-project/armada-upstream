import { describe, expect, it } from "vitest";

import {
  RELEASE_KIND,
  artifactOs,
  compareVersions,
  featuredRelease,
  foldReleases,
  parseRelease,
  type Release,
} from "@/lib/releases";

/** A real v0.55.3 artifact tag, hash and all. */
const APPIMAGE = [
  "artifact",
  "url https://blossom.ditto.pub/aef4cd12f86e8afed97ca215ca2641b4fd12f6c1c88ea3d55769a387fffec7ef.AppImage",
  "x aef4cd12f86e8afed97ca215ca2641b4fd12f6c1c88ea3d55769a387fffec7ef",
  "m application/vnd.appimage",
  "size 142871382",
  "f linux-x86_64",
  "filename Armada-v0.55.3.AppImage",
  "alt Linux AppImage (x86_64)",
];

function event(overrides: Partial<{ kind: number; tags: string[][]; content: string }> = {}) {
  return {
    id: "a".repeat(64),
    kind: RELEASE_KIND,
    pubkey: "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5",
    created_at: 1787332212,
    content: "### Security\n- something",
    tags: [
      ["d", "armada@v0.55.3"],
      ["D", "armada"],
      ["r", "refs/tags/v0.55.3"],
      ["commit", "b2b4e840bee180905ea2b64f2be46f91e47ba6e9"],
      ["version", "v0.55.3"],
      ["title", "Armada v0.55.3"],
      ["c", "main"],
      APPIMAGE,
      ["f", "linux-x86_64"],
    ],
    ...overrides,
  };
}

describe("parseRelease", () => {
  it("reads a release and its artifacts", () => {
    const release = parseRelease(event());
    expect(release).toMatchObject({
      repoId: "armada",
      version: "v0.55.3",
      title: "Armada v0.55.3",
      channel: "main",
      commit: "b2b4e840bee180905ea2b64f2be46f91e47ba6e9",
    });
    expect(release?.artifacts).toHaveLength(1);
    expect(release?.artifacts[0]).toMatchObject({
      hash: "aef4cd12f86e8afed97ca215ca2641b4fd12f6c1c88ea3d55769a387fffec7ef",
      mime: "application/vnd.appimage",
      size: 142871382,
      platform: "linux-x86_64",
      filename: "Armada-v0.55.3.AppImage",
      os: "linux",
    });
  });

  it("keeps the whole alt label, which contains spaces", () => {
    // Splitting each field on every space rather than the first would truncate
    // every human label to one word.
    expect(parseRelease(event())?.artifacts[0].label).toBe("Linux AppImage (x86_64)");
  });

  it("falls back to the d tag when D is absent, splitting on the last @", () => {
    const release = parseRelease(event({
      tags: [["d", "my@repo@v1.2.3"], APPIMAGE],
    }));
    expect(release?.repoId).toBe("my@repo");
    expect(release?.version).toBe("v1.2.3");
  });

  it("defaults the channel to main so an untagged release still sorts as stable", () => {
    const release = parseRelease(event({ tags: [["d", "armada@v1.0.0"], APPIMAGE] }));
    expect(release?.channel).toBe("main");
  });

  it("refuses anything it cannot render", () => {
    expect(parseRelease(event({ kind: 1 }))).toBeUndefined();
    // No version: it could be neither labelled nor ordered.
    expect(parseRelease(event({ tags: [["D", "armada"], APPIMAGE] }))).toBeUndefined();
    // No artifacts: a version with no downloads is worse than no card at all.
    expect(parseRelease(event({ tags: [["d", "armada@v1.0.0"], ["version", "v1.0.0"]] }))).toBeUndefined();
  });

  it("drops an artifact missing the two fields a button needs", () => {
    const release = parseRelease(event({
      tags: [
        ["d", "armada@v1.0.0"],
        ["version", "v1.0.0"],
        ["D", "armada"],
        ["artifact", "x abc", "m application/zip"],
        APPIMAGE,
      ],
    }));
    expect(release?.artifacts).toHaveLength(1);
  });
});

describe("artifactOs", () => {
  it("files each published platform token", () => {
    expect(artifactOs("linux-x86_64", "x.AppImage")).toBe("linux");
    expect(artifactOs("windows-x86_64", "x.exe")).toBe("windows");
    expect(artifactOs("darwin-aarch64", "x.zip")).toBe("macos");
    expect(artifactOs("darwin-x86_64", "x.zip")).toBe("macos");
    expect(artifactOs("android-arm64-v8a", "x.apk")).toBe("android");
  });

  it("falls back to the filename for a token this build doesn't know", () => {
    // `f` is advisory: the published vocabulary is thin and still moving, so an
    // unrecognized token must cost a grouping hint, never a download button.
    expect(artifactOs("linux-riscv64", "Armada.AppImage")).toBe("linux");
    expect(artifactOs("", "Armada-Setup.exe")).toBe("windows");
    expect(artifactOs("", "Armada.deb")).toBe("linux");
    expect(artifactOs("", "Armada-mac-arm64.zip")).toBe("macos");
    expect(artifactOs("", "Armada.apk")).toBe("android");
  });

  it("returns undefined rather than guessing at something unplaceable", () => {
    expect(artifactOs("", "SHA256SUMS")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    // The whole reason this exists: "0.9.0" > "0.55.3" as strings.
    expect(compareVersions("v0.55.3", "v0.9.0")).toBeLessThan(0);
    expect([...["v0.9.0", "v0.55.3", "v0.10.1"]].sort(compareVersions))
      .toEqual(["v0.55.3", "v0.10.1", "v0.9.0"]);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("v1.2.3", "v1.2.3-rc.1")).toBeLessThan(0);
    expect(compareVersions("v1.2.3-rc.2", "v1.2.3-rc.1")).toBeLessThan(0);
  });
});

describe("featuredRelease", () => {
  const rel = (version: string, channel: string): Release => ({
    id: version,
    pubkey: "p",
    createdAt: 1,
    repoId: "armada",
    version,
    title: version,
    channel,
    commit: undefined,
    notes: "",
    artifacts: [],
  });

  it("skips a prerelease that sorts above the newest stable", () => {
    // v1.3.0-rc.1 is genuinely newer than v1.2.0, so the head of the list is a
    // release candidate. Featuring it would hand every visitor an rc build.
    const featured = featuredRelease([rel("v1.3.0-rc.1", "rc"), rel("v1.2.0", "main")]);
    expect(featured?.version).toBe("v1.2.0");
  });

  it("takes the newest stable when the list leads with one", () => {
    expect(featuredRelease([rel("v1.2.0", "main"), rel("v1.1.0", "main")])?.version).toBe("v1.2.0");
  });

  it("falls back to a prerelease when nothing stable was ever tagged", () => {
    expect(featuredRelease([rel("v0.1.0-rc.2", "rc"), rel("v0.1.0-rc.1", "rc")])?.version)
      .toBe("v0.1.0-rc.2");
  });

  it("has nothing to offer for an empty list", () => {
    expect(featuredRelease([])).toBeUndefined();
  });
});

describe("foldReleases", () => {
  const at = (version: string, createdAt: number, id: string): Release => ({
    id,
    pubkey: "p",
    createdAt,
    repoId: "armada",
    version,
    title: version,
    channel: "main",
    commit: undefined,
    notes: "",
    artifacts: [],
  });

  it("keeps the newest event per version and sorts newest version first", () => {
    const folded = foldReleases([
      at("v1.0.0", 100, "old"),
      at("v1.0.0", 200, "republished"),
      at("v1.1.0", 150, "next"),
    ]);
    expect(folded.map((r) => r.version)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(folded.find((r) => r.version === "v1.0.0")?.id).toBe("republished");
  });
});
