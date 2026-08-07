"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_INPUTS = ["db.cjs", path.join("dist", "index.html")];

function assertPackInputs(appDirectory = path.resolve(__dirname, "..")) {
  const missing = REQUIRED_INPUTS.filter(
    (relativePath) => !fs.statSync(path.join(appDirectory, relativePath), { throwIfNoEntry: false })?.isFile(),
  );
  if (missing.length > 0) {
    throw new Error(
      `desktop package inputs are missing: ${missing.join(", ")}; run npm run stage:web first`,
    );
  }
}

module.exports = async function beforePack(context) {
  assertPackInputs(context?.appDir);
};
module.exports.assertPackInputs = assertPackInputs;
