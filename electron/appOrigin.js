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

/**
 * Schemes Armada will hand to the operating system's default handler.
 *
 * Deliberately a tiny allowlist rather than a denylist of known-bad schemes.
 * `setWindowOpenHandler` fires for `window.open` from ANY frame in the
 * renderer, and the app embeds untrusted third-party content — WebXDC apps run
 * in a sandbox that carries `allow-popups-to-escape-sandbox`, and link embeds
 * load foreign origins. Anything reaching shell.openExternal is therefore a
 * string a stranger may have chosen, and the OS will happily launch a handler
 * for `file:`, `smb:`, `ms-msdt:` or any installed app's private scheme.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Whether a URL may be opened in the user's browser / mail client. */
function isExternallyOpenableUrl(value) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

module.exports = { isArmadaAppUrl, isExternallyOpenableUrl };
