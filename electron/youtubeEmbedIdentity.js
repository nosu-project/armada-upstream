"use strict";

// YouTube requires an HTTP(S) client identity on embedded-player requests.
// Chromium cannot derive one from Armada's packaged app://armada origin, so
// identify the installed desktop app with its reverse-DNS OS application id.
// This is deliberately NOT Armada's hosted-web origin: browser deployments
// (including self-hosted ones and ARMADA_DEV_URL) send their own HTTP(S)
// Referer, which this policy preserves unchanged.
const PACKAGED_APP_REFERRER = "https://buzz.armada.app/";

const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtube.com",
  "www.youtube.com",
]);

// Keep Chromium from invoking the listener for unrelated traffic, then repeat
// the checks in the listener before changing a header. The second check makes
// the security boundary testable and prevents a future broader filter from
// quietly attaching Armada's app identity to arbitrary requests.
const YOUTUBE_EMBED_FILTER = {
  urls: [
    "https://youtube-nocookie.com/embed/*",
    "https://www.youtube-nocookie.com/embed/*",
    "https://youtube.com/embed/*",
    "https://www.youtube.com/embed/*",
  ],
  types: ["subFrame"],
};

function isHttpReferrer(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => {
    if (typeof item !== "string") return false;
    try {
      const protocol = new URL(item).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });
}

function isYouTubeEmbedSubFrame(details) {
  if (details?.resourceType !== "subFrame") return false;
  try {
    const url = new URL(details.url);
    return (
      url.protocol === "https:" &&
      YOUTUBE_EMBED_HOSTS.has(url.hostname) &&
      url.pathname.startsWith("/embed/")
    );
  } catch {
    return false;
  }
}

/**
 * Add YouTube's required app identity without replacing a real web origin.
 * Electron header keys are not guaranteed to use one casing, so lookup and
 * replacement are case-insensitive.
 */
function requestHeadersWithYouTubeIdentity(details) {
  const headers = details?.requestHeaders ?? {};
  if (!isYouTubeEmbedSubFrame(details)) return headers;

  const refererNames = Object.keys(headers).filter(
    (name) => name.toLowerCase() === "referer",
  );
  if (refererNames.some((name) => isHttpReferrer(headers[name]))) return headers;

  const nextHeaders = { ...headers };
  const headerName = refererNames[0] ?? "Referer";
  nextHeaders[headerName] = PACKAGED_APP_REFERRER;
  // A malformed headers object can contain multiple casing variants. Emit
  // exactly one Referer instead of leaving an invalid duplicate beside it.
  for (const duplicate of refererNames.slice(1)) delete nextHeaders[duplicate];
  return nextHeaders;
}

/** Install the policy after app readiness but before the first window loads. */
function installYouTubeEmbedIdentity({ webRequest, isPackaged }) {
  if (!isPackaged) return false;
  webRequest.onBeforeSendHeaders(YOUTUBE_EMBED_FILTER, (details, callback) => {
    callback({ requestHeaders: requestHeadersWithYouTubeIdentity(details) });
  });
  return true;
}

module.exports = {
  PACKAGED_APP_REFERRER,
  YOUTUBE_EMBED_FILTER,
  installYouTubeEmbedIdentity,
  isYouTubeEmbedSubFrame,
  requestHeadersWithYouTubeIdentity,
};
