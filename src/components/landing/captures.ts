import { useSyncExternalStore } from "react";

/**
 * The landing's product captures, as Blossom blobs rather than files in the
 * static build. Each is on all three of the app's default servers; the URL
 * names the first and `CAPTURE_MIRRORS` the rest, so `FallbackImage` walks to
 * another copy when one server is down — the same walk every other image takes,
 * under the same media policy.
 *
 * Regenerating them (`e2e/landing-screenshots.spec.ts`) writes local files;
 * upload those and replace the hashes here.
 */

export type CaptureSize = "desktop" | "mobile";

const PRIMARY = "https://blossom.ditto.pub";
const MIRRORS = ["https://blossom.primal.net", "https://blossom.dreamith.to"];

const HASHES: Record<string, Record<CaptureSize, string>> = {
  "raid-crew": {
    desktop: "0e10b0fc071d56a3dee9e874f57c89fa775a34adc9609abd623db3de096656ba",
    mobile: "8ab7e95f4f6280349c218a3a4c6e73c1b60e649db2deaaa1f6dc20e57834da57",
  },
  "book-club": {
    desktop: "13a9d2b97ad65c55277b0b76da776f776f4beebb305d3c491034dbca1381c95f",
    mobile: "7b9e6ec098ff8e8e849c1743d498dca52be90ae7a0f386b8cf85d241600d408a",
  },
  band: {
    desktop: "3995f6b7a43896310961e3a6da98ad9feac6756aecf821e576a8c9e86edd2869",
    mobile: "7ea7322d07a5d5369f4748973b1a062de2950148f7b3d2b288e8924e700f45cc",
  },
  "dev-team": {
    desktop: "8c18f287b347ba40db84e605cafbbb82adcfe488cfaf0995bd9fd6dd23778279",
    mobile: "2ee3eab8f7a438ebcf2399ef272c5efdca4e62109fa41f32cff4bf0ee7ea69d0",
  },
  family: {
    desktop: "1b32f53b01663326dace8ee82cc7b42477be722e5d5c1761be344f7101703b0a",
    mobile: "015831a9980460bdd8d28503e0ec1bbb25bcdea1a5b33c2d461a9618c580b58f",
  },
};

/** The capture's primary URL, or `undefined` for a slug with none. */
export function captureUrl(slug: string, size: CaptureSize): string | undefined {
  const hash = HASHES[slug]?.[size];
  return hash ? `${PRIMARY}/${hash}.webp` : undefined;
}

/** The same blob on the other servers, as declared fallbacks. */
export function captureMirrors(slug: string, size: CaptureSize): string[] {
  const hash = HASHES[slug]?.[size];
  return hash ? MIRRORS.map((server) => `${server}/${hash}.webp`) : [];
}

/** Below Tailwind's `sm`, where a desktop capture is unreadable. */
const PHONE_QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const getSize = (): CaptureSize => (window.matchMedia(PHONE_QUERY).matches ? "mobile" : "desktop");

/** Which capture fits this viewport: the phone one under `sm`. */
export function useCaptureSize(): CaptureSize {
  return useSyncExternalStore(subscribe, getSize);
}
