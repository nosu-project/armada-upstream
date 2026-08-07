"use strict";

/**
 * Whether a URL belongs to the packaged renderer's app://armada origin.
 *
 * Node's URL implementation reports `.origin === "null"` for custom schemes,
 * even when Electron registered that scheme as standard and secure. Compare
 * the parsed protocol and authority instead so permission requests from the
 * packaged renderer are admitted without trusting lookalike hosts or userinfo.
 */
function isArmadaAppUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.host === "armada" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

module.exports = { isArmadaAppUrl };
