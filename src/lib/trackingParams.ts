/**
 * Tracking-parameter stripping (`si`, `fbclid`, `utm_*`, …) for outgoing and
 * incoming message bodies — on send so published content is clean, on view so
 * links from elsewhere are cleaned before render/unfurl.
 *
 * Conservative by design: only NAMED parameters are removed (no heuristics — a
 * broken link is worse than a tracked one), and nothing else changes. Unchanged
 * URLs return by identity and survivors keep their original bytes (no
 * `URLSearchParams` round-trip), because attachment URLs match their NIP-92
 * `imeta` by exact string.
 */

/**
 * Click/campaign identifiers stripped on every host. Params meaningful on some
 * sites (`ref`, `source`, `s`, `t`) belong in host rules instead.
 */
const GLOBAL_PARAMS: ReadonlySet<string> = new Set([
  // Ad-network click ids.
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "gad_campaignid",
  "srsltid",
  "msclkid",
  "twclid",
  "ttclid",
  "yclid",
  "ymclid",
  "ysclid",
  "igshid",
  "igsh",
  "epik",
  "irclickid",
  "cjevent",
  "rdt_cid",
  "sc_cid",
  "wickedid",
  "s_kwcid",
  "ef_id",
  "mkwid",
  "pcrid",
  "zanpid",
  "ranmid",
  "raneaid",
  "ransiteid",
  // Email / marketing-automation campaign ids.
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "__s",
  "_hsenc",
  "_hsmi",
  "__hsfp",
  "__hssc",
  "__hstc",
  "hsctatracking",
  "trk_contact",
  "trk_msg",
  "trk_module",
  "trk_sid",
  // Analytics platforms.
  "_openstat",
  "icid",
  "ncid",
  "cmpid",
  "campid",
  // Consent-wall round-trip, added by Yahoo/AOL properties.
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
]);

/** Parameter prefixes stripped everywhere (GA, Matomo/Piwik, HubSpot, Vero, Omeda). */
const GLOBAL_PREFIXES: readonly string[] = [
  "utm_",
  "pk_",
  "piwik_",
  "matomo_",
  "mtm_",
  "hsa_",
  "vero_",
  "oly_",
];

interface HostRule {
  /** Host suffixes; each also matches all subdomains. */
  hosts: readonly string[];
  params?: readonly string[];
  prefixes?: readonly string[];
  /** Shape-based host match (Google's many ccTLDs). */
  matchHost?: (host: string) => boolean;
  /** Path canonicalization, for sites encoding tracking in the path. */
  canonical?: (u: URL) => { pathname?: string; dropQuery?: boolean } | void;
}

/**
 * Per-host rules, checked against each site's own share sheet. When in doubt a
 * parameter is left alone.
 */
const HOST_RULES: readonly HostRule[] = [
  {
    // `si` = per-share id, `pp` = Shorts player blob. `v`/`list`/`index`/`t`/
    // `start`/`end` change playback and stay.
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com"],
    params: [
      "si",
      "pp",
      "feature",
      "ab_channel",
      "kw",
      "source_ve_path",
      "embeds_referring_euri",
      "embeds_referring_origin",
      "embeds_euri",
      "embeds_origin",
      "themerefresh",
      "app",
    ],
  },
  {
    // `s` and `t` are the tweet share sheet's pair; `s` alone is also what the
    // "Copy link" button adds.
    hosts: ["x.com", "twitter.com"],
    params: ["s", "t", "src", "ref_src", "ref_url", "cxt", "tw_p"],
  },
  {
    hosts: ["facebook.com", "fb.watch", "fb.com"],
    params: [
      "ref",
      "refsrc",
      "hrc",
      "_rdr",
      "dti",
      "app",
      "sfnsn",
      "idorvanity",
      "wtsid",
      "rdid",
      "paipv",
      "eid",
      "comment_tracking",
      "action_history",
      "tracking",
      "video_source",
      "referral_code",
      "referral_story_type",
    ],
    prefixes: ["__tn__", "__cft__", "_ft_", "_nc_"],
  },
  {
    hosts: ["instagram.com"],
    params: ["source"],
  },
  {
    hosts: ["tiktok.com"],
    params: [
      "is_from_webapp",
      "sender_device",
      "sender_web_id",
      "web_id",
      "_r",
      "_t",
      "u_code",
      "preview_pb",
      "share_app_id",
      "share_item_id",
      "share_link_id",
      "share_author_id",
      "social_share_type",
      "tt_from",
      "source",
      "timestamp",
      "enter_from",
      "enter_method",
      "checksum",
      "sec_user_id",
      "ug_btm",
    ],
  },
  {
    // `context` and `sort` change which comments a permalink shows, so they
    // stay; everything below is share-sheet or app-attribution bookkeeping.
    hosts: ["reddit.com", "redd.it"],
    params: [
      "share_id",
      "correlation_id",
      "ref",
      "ref_source",
      "rdt",
      "chainedposts",
      "post_fullname",
      "$deep_link",
      "$original_url",
      "_branch_match_id",
      "_branch_referrer",
    ],
  },
  {
    // Product links canonicalize to the bare ASIN (tracking lives in the path
    // too); non-product paths keep their query (`k=` is the search).
    hosts: [
      "amazon.com",
      "amazon.co.uk",
      "amazon.ca",
      "amazon.de",
      "amazon.fr",
      "amazon.it",
      "amazon.es",
      "amazon.nl",
      "amazon.se",
      "amazon.pl",
      "amazon.in",
      "amazon.co.jp",
      "amazon.com.au",
      "amazon.com.br",
      "amazon.com.mx",
      "amazon.ae",
      "amazon.sg",
    ],
    params: [
      "ref",
      "psc",
      "qid",
      "sr",
      "sprefix",
      "crid",
      "th",
      "_encoding",
      "smid",
      "dib",
      "dib_tag",
      "content-id",
      "linkcode",
      "tag",
      "ascsubtag",
      "creative",
      "creativeasin",
      "linkid",
      "camp",
    ],
    prefixes: ["pd_rd_", "pf_rd_", "ref_"],
    canonical: (u) => {
      const m = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})(?:[/?]|$)/.exec(u.pathname);
      if (m) return { pathname: `/dp/${m[1]}`, dropQuery: true };
    },
  },
  {
    hosts: ["spotify.com", "spotify.link"],
    params: ["si", "nd", "_branch_match_id", "_branch_referrer"],
  },
  {
    // `i` names the track/episode within an album or show and must survive;
    // `at`/`itsct`/`itscg` are the affiliate and campaign tokens.
    hosts: ["apple.com"],
    params: ["at", "ct", "uo", "ls", "itscg", "itsct", "app"],
  },
  {
    hosts: ["soundcloud.com"],
    params: ["si", "ref"],
  },
  {
    hosts: ["twitch.tv"],
    params: ["tt_content", "tt_medium", "sr"],
  },
  {
    hosts: ["bilibili.com", "b23.tv"],
    params: [
      "spm_id_from",
      "from_source",
      "from_spmid",
      "share_source",
      "share_medium",
      "share_plat",
      "share_session_id",
      "share_tag",
      "unique_k",
      "vd_source",
      "buvid",
      "is_story_h5",
      "plat_id",
      "bbid",
      "ts",
      "timestamp",
      "mid",
    ],
  },
  {
    hosts: ["linkedin.com"],
    params: [
      "trk",
      "trkinfo",
      "traceid",
      "trackingid",
      "originalsubdomain",
      "refid",
      "midtoken",
      "midsig",
      "ebp",
      "li_fat_id",
      "licu",
      "lipi",
      "lici",
    ],
  },
  {
    hosts: ["medium.com"],
    params: ["source", "sk", "gi"],
  },
  {
    hosts: ["substack.com"],
    params: [
      "r",
      "showwelcome",
      "triedredirect",
      "triggershare",
      "isfreemail",
      "post_id",
      "publication_id",
    ],
  },
  {
    // `ved`/`ei`/`sxsrf` identify the click/session; `q`/`tbm`/`tbs`/`hl` stay.
    hosts: ["google.com"],
    matchHost: isGoogleHost,
    params: [
      "ved",
      "ei",
      "usg",
      "sa",
      "source",
      "oq",
      "aqs",
      "sourceid",
      "client",
      "sclient",
      "uact",
      "sxsrf",
      "iflsig",
      "gws_rd",
      "bih",
      "biw",
      "dpr",
    ],
    prefixes: ["gs_"],
  },
  {
    hosts: ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.es", "ebay.ca", "ebay.com.au"],
    params: [
      "_trkparms",
      "_trksid",
      "hash",
      "amdata",
      "mkevt",
      "mkcid",
      "mkrid",
      "campid",
      "customid",
      "toolid",
      "ul_noapp",
    ],
  },
  {
    hosts: ["aliexpress.com", "aliexpress.us"],
    params: ["spm", "scm", "scm_id", "scm-url", "pvid", "btsid", "ws_ab_test", "gatewayadapt", "srcsns", "businesstype", "curpageloguid"],
    prefixes: ["aff_", "pdp_", "algo_"],
  },
  {
    hosts: ["etsy.com"],
    params: ["click_key", "click_sum", "ref", "frs", "sts", "organic_search_click", "plkey"],
    prefixes: ["ga_"],
  },
  {
    hosts: ["walmart.com"],
    params: ["from", "sid", "adsredirect", "classtype"],
    prefixes: ["ath"],
  },
  {
    hosts: ["target.com"],
    params: ["preselect", "lnk", "clkid", "afid", "ref"],
  },
  {
    hosts: ["imdb.com"],
    params: ["ref_", "pf_rd_p", "pf_rd_r"],
  },
  {
    hosts: ["steampowered.com", "steamcommunity.com"],
    params: ["snr"],
  },
  {
    hosts: ["bandcamp.com"],
    params: ["from", "search_item_id", "search_page_id", "search_rank", "search_sig", "label"],
  },
  {
    hosts: ["pinterest.com"],
    params: ["nic_v1", "nic_v2", "nic_v3", "sender"],
  },
];

/** Whether `host` is `suffix` or a subdomain of it. */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Google search spans ~190 ccTLDs, so match the shape. */
function isGoogleHost(host: string): boolean {
  return /(^|\.)google(\.[a-z]{2,3})+$/.test(host);
}

function ruleFor(host: string): HostRule | undefined {
  return HOST_RULES.find(
    (rule) =>
      rule.matchHost?.(host) || rule.hosts.some((suffix) => hostMatches(host, suffix)),
  );
}

/** Whether a parameter name is stripped, given the rule for its host. */
function isTracking(name: string, rule: HostRule | undefined): boolean {
  const lower = name.toLowerCase();
  if (GLOBAL_PARAMS.has(lower)) return true;
  if (GLOBAL_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (!rule) return false;
  if (rule.params?.includes(lower)) return true;
  if (rule.prefixes?.some((p) => lower.startsWith(p))) return true;
  return false;
}

/**
 * Remove tracking parameters from one URL. Returns the input BY IDENTITY when
 * not http(s), unparseable, or untouched.
 */
export function stripTrackingParams(url: string): string {
  // Cheap pre-parse rejection: most URLs have no query.
  if (!url.includes("?") && !url.includes("/dp/") && !url.includes("/gp/")) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;

  const rule = ruleFor(parsed.hostname.toLowerCase());

  // Slice the ORIGINAL string so survivors keep their exact bytes.
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  let base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  let changed = false;
  let dropQuery = false;

  const canonical = rule?.canonical?.(parsed);
  if (canonical?.pathname && canonical.pathname !== parsed.pathname) {
    base = `${parsed.protocol}//${parsed.host}${canonical.pathname}`;
    changed = true;
    dropQuery = canonical.dropQuery ?? false;
  }

  let keptQuery = "";
  if (query && !dropQuery) {
    const kept = query.split("&").filter((pair) => {
      if (!pair) return false;
      const eq = pair.indexOf("=");
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        // Malformed escape: keep as-is.
      }
      return !isTracking(name, rule);
    });
    if (kept.length !== query.split("&").filter(Boolean).length) changed = true;
    keptQuery = kept.join("&");
  } else if (query && dropQuery) {
    changed = true;
  }

  if (!changed) return url;
  return `${base}${keptQuery ? `?${keptQuery}` : ""}${fragment}`;
}

/** URLs in a message body (like the renderer's tokenizer, minus relay `wss?:` URLs). */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<]+/gi;

/**
 * Trim greedy trailing punctuation, keeping a `)` that balances one in the URL.
 * Mirrors `ChatContent`'s tokenizer; this copy serves the send path.
 */
function splitTrailingPunctuation(url: string): [string, string] {
  const m = /^(.*?)([.,;:!?)\]]+)$/.exec(url);
  if (!m) return [url, ""];
  let [, head, punct] = m;
  while (punct.startsWith(")")) {
    const opens = (head.match(/\(/g) ?? []).length;
    const closes = (head.match(/\)/g) ?? []).length;
    if (opens <= closes) break;
    head += ")";
    punct = punct.slice(1);
  }
  if (!punct || !head || head.length <= 10) return [url, ""];
  return [head, punct];
}

/** Strip tracking from every URL in text (send path); identity when unchanged. */
export function stripTrackingParamsInText(text: string): string {
  if (!text.includes("http")) return text;
  let changed = false;
  const out = text.replace(URL_IN_TEXT_RE, (match) => {
    const [url, punct] = splitTrailingPunctuation(match);
    const cleaned = stripTrackingParams(url);
    if (cleaned === url) return match;
    changed = true;
    return `${cleaned}${punct}`;
  });
  return changed ? out : text;
}
