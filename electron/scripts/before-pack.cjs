"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_INPUTS = ["db.cjs", "updateFeed.cjs", path.join("dist", "index.html")];
const BUILDER_ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

function normalizeArch(value) {
  if (typeof value === "string" && value) return value;
  return BUILDER_ARCH_NAMES[value] || process.arch;
}

function assertPackInputs(
  appDirectory = path.resolve(__dirname, ".."),
  { platform = process.platform, arch = process.arch } = {},
) {
  const missing = REQUIRED_INPUTS.filter(
    (relativePath) => !fs.statSync(path.join(appDirectory, relativePath), { throwIfNoEntry: false })?.isFile(),
  );
  if (platform === "linux") {
    const helper = path.join(
      appDirectory,
      "generated",
      "hevc",
      normalizeArch(arch),
      "armada-hevc-publisher",
    );
    const stat = fs.statSync(helper, { throwIfNoEntry: false });
    if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
      missing.push(path.relative(appDirectory, helper));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `desktop package inputs are missing: ${missing.join(", ")}; run npm run stage:web first`,
    );
  }
}

module.exports = async function beforePack(context) {
  assertPackInputs(context?.appDir, {
    platform: context?.electronPlatformName,
    arch: normalizeArch(context?.arch),
  });
};
module.exports.assertPackInputs = assertPackInputs;
module.exports.normalizeArch = normalizeArch;
