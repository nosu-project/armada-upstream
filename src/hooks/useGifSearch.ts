import { useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

const RESULTS_LIMIT = 30;

export interface GifPreviewSource {
  src: string;
  /** `type` for the <source>, so the browser can skip formats it can't play. */
  type: string;
}

export interface GifResult {
  /** Provider-specific id; also used by KLIPY's share-tracking endpoint. */
  id: string;
  title: string;
  /** URL for the full-size GIF. This is what gets shared into a message. */
  url: string;
  /** Video renditions for the picker grid, cheapest first. */
  previewSources?: GifPreviewSource[];
  /** Width of the shared GIF rendition. */
  width: number;
  /** Height of the shared GIF rendition. */
  height: number;
}

type GifFetch = { results: GifResult[] };

/**
 * GIF provider selection. GIFverse is the keyless default so a fresh build has
 * working GIF search out of the box. KLIPY is opt-in: it is used only when a
 * `VITE_KLIPY_API_KEY` is baked into the build. KLIPY additionally requires a
 * per-install `customer_id` on every request and injects sponsored results, so
 * it is never the default.
 */
function klipyConfigured(): boolean {
  return Boolean(import.meta.env.VITE_KLIPY_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// GIFverse provider (default, keyless)
// ---------------------------------------------------------------------------

const GIFVERSE_BASE_URL = 'https://gifverse.net/api/v1';
const GIFVERSE_MEDIA_URL = 'https://gifverse.net/media';

interface GifverseResult {
  /** GIF id */
  i: string;
  /** Title */
  ti: string;
  /** Description */
  de?: string;
  /** Width */
  w: number;
  /** Height */
  h: number;
  /** Available video formats (e.g. av1, webm, mp4) */
  f: string[];
  /** NSFW flag */
  nsfw: boolean;
}

interface GifverseResponse {
  results: GifverseResult[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

/** Video formats we'll play in the grid, cheapest first. */
const PREVIEW_FORMATS: { format: string; type: string }[] = [
  { format: 'webm', type: 'video/webm' },
  { format: 'mp4', type: 'video/mp4' },
];

/**
 * Video renditions of a GIF for the picker grid. GIFverse serves every format
 * it lists in `f` from `/media/<id>/<format>` — the same animation as
 * `original.gif` at a fraction of the size (a trending GIF runs ~1–1.8 MB as a
 * GIF but ~100–350 KB as webm). The grid shows 30 at once, so sending the
 * originals meant tens of megabytes and 30 CPU-decoded GIF animations per open.
 *
 * GIFverse also offers `av1`, which is smaller again (~25–70 KB), but it's
 * deliberately skipped: on devices without AV1 hardware decode the browser
 * falls back to software decode, and 30 concurrently-looping software-decoded
 * streams costs more than the bytes save.
 *
 * `formats` is optional so favorites persisted before this existed (which only
 * kept the id) can still resolve their previews.
 */
export function gifPreviewSources(id: string, formats?: string[]): GifPreviewSource[] {
  return PREVIEW_FORMATS.filter(({ format }) => !formats || formats.includes(format)).map(
    ({ format, type }) => ({ src: `${GIFVERSE_MEDIA_URL}/${id}/${format}`, type }),
  );
}

function mapGifverseResult(result: GifverseResult): GifResult {
  return {
    id: result.i,
    title: result.ti || result.de || '',
    url: `${GIFVERSE_MEDIA_URL}/${result.i}/original.gif`,
    previewSources: gifPreviewSources(result.i, result.f),
    width: result.w || 220,
    height: result.h || 160,
  };
}

function mapGifverseResults(data: GifverseResponse): GifResult[] {
  return data.results.filter((r) => !r.nsfw).map(mapGifverseResult);
}

async function fetchGifverse(path: 'search' | 'trending', query?: string): Promise<GifFetch> {
  const params = new URLSearchParams({
    limit: String(RESULTS_LIMIT),
    offset: '0',
    sort: path === 'search' ? 'relevant' : 'popular',
  });
  if (query) params.set('q', query);

  const res = await fetch(`${GIFVERSE_BASE_URL}/${path}?${params}`);
  if (!res.ok) throw new Error(`GIFverse ${path} failed: ${res.status}`);

  const data: GifverseResponse = await res.json();
  return { results: mapGifverseResults(data) };
}

// ---------------------------------------------------------------------------
// KLIPY provider (opt-in via VITE_KLIPY_API_KEY)
// ---------------------------------------------------------------------------

const KLIPY_BASE_URL = 'https://api.klipy.com/api/v1';
const KLIPY_CUSTOMER_ID_KEY = 'armada:klipy-customer-id';

interface KlipyMediaFile {
  url?: string;
  width?: number;
  height?: number;
}

interface KlipyFileTypes {
  gif?: KlipyMediaFile;
  webp?: KlipyMediaFile;
  mp4?: KlipyMediaFile;
}

interface KlipyResult {
  id?: string | number;
  slug?: string;
  title?: string;
  type?: string;
  file?: {
    hd?: KlipyFileTypes;
    md?: KlipyFileTypes;
    sm?: KlipyFileTypes;
    xs?: KlipyFileTypes;
  };
}

interface KlipyResponse {
  result?: boolean;
  data?: {
    data?: KlipyResult[];
    has_next?: boolean;
  } | KlipyResult[];
}

function apiKey(): string {
  const key = import.meta.env.VITE_KLIPY_API_KEY?.trim();
  if (!key) throw new Error('KLIPY API key is not configured');
  return key;
}

let sessionCustomerId: string | undefined;

function createCustomerId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `armada-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function customerId(): string {
  try {
    const existing = localStorage.getItem(KLIPY_CUSTOMER_ID_KEY);
    if (existing) return existing;
    const created = createCustomerId();
    localStorage.setItem(KLIPY_CUSTOMER_ID_KEY, created);
    return created;
  } catch {
    // Storage can be unavailable in private/restricted WebViews. The identifier
    // is analytics-only, so an in-memory value is sufficient for that session.
    sessionCustomerId ??= createCustomerId();
    return sessionCustomerId;
  }
}

function klipyEndpoint(path: string): URL {
  return new URL(`${KLIPY_BASE_URL}/${encodeURIComponent(apiKey())}/gifs/${path}`);
}

function firstFile(
  variants: Array<KlipyFileTypes | undefined>,
  format: keyof KlipyFileTypes,
): KlipyMediaFile | undefined {
  for (const variant of variants) {
    const file = variant?.[format];
    if (file?.url) return file;
  }
  return undefined;
}

function mapKlipyResult(result: KlipyResult): GifResult | undefined {
  if (result.type === 'ad') return undefined;

  const id = result.slug || (result.id == null ? '' : String(result.id));
  const variants = result.file;
  // Share a high-quality GIF while keeping the grid on lightweight video.
  const shared = firstFile([variants?.hd, variants?.md, variants?.sm, variants?.xs], 'gif');
  if (!id || !shared?.url) return undefined;

  const previews = [variants?.xs, variants?.sm, variants?.md, variants?.hd]
    .map((variant) => variant?.mp4)
    .filter((file): file is KlipyMediaFile => Boolean(file?.url));
  const seen = new Set<string>();
  const previewSources = previews.flatMap((file) => {
    if (!file.url || seen.has(file.url)) return [];
    seen.add(file.url);
    return [{ src: file.url, type: 'video/mp4' }];
  });

  return {
    id,
    title: result.title ?? '',
    url: shared.url,
    previewSources: previewSources.length > 0 ? previewSources : undefined,
    width: shared.width || 220,
    height: shared.height || 160,
  };
}

/** Public for focused response-shape tests. */
export function mapKlipyResults(response: KlipyResponse): GifResult[] {
  const payload = Array.isArray(response.data) ? response.data : response.data?.data;
  return (payload ?? []).flatMap((result) => {
    const mapped = mapKlipyResult(result);
    return mapped ? [mapped] : [];
  });
}

async function fetchKlipy(path: 'search' | 'trending', query?: string): Promise<GifFetch> {
  const url = klipyEndpoint(path);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', String(RESULTS_LIMIT));
  url.searchParams.set('customer_id', customerId());
  url.searchParams.set('locale', navigator.language || 'en');
  if (query) url.searchParams.set('q', query);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`KLIPY ${path} failed: ${res.status}`);

  const data: KlipyResponse = await res.json();
  return { results: mapKlipyResults(data) };
}

/**
 * Best-effort share analytics for the selected GIF; selecting the GIF must
 * never wait on it. Only KLIPY tracks shares — GIFverse has no such endpoint,
 * so this is a no-op unless KLIPY is the configured provider.
 */
export async function registerGifShare(slug: string): Promise<void> {
  if (!slug || !klipyConfigured()) return;
  try {
    const res = await fetch(klipyEndpoint(`share/${encodeURIComponent(slug)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customerId() }),
    });
    if (!res.ok) console.warn(`KLIPY share tracking failed: ${res.status}`);
  } catch (error) {
    console.warn('KLIPY share tracking failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Provider-agnostic hook
// ---------------------------------------------------------------------------

export function useGifSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value.trim());
    }, 300);
  }, []);

  const clearQuery = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    clearTimeout(debounceRef.current);
  }, []);

  const isSearching = debouncedQuery.length > 0;

  const useKlipy = klipyConfigured();
  const provider = useKlipy ? 'klipy' : 'gifverse';
  const fetchGifs = useKlipy ? fetchKlipy : fetchGifverse;

  const trendingQuery = useQuery({
    queryKey: [provider, 'trending'],
    queryFn: () => fetchGifs('trending'),
    staleTime: 5 * 60 * 1000,
    enabled: !isSearching,
  });

  const searchQuery = useQuery({
    queryKey: [provider, 'search', debouncedQuery],
    queryFn: () => fetchGifs('search', debouncedQuery),
    staleTime: 2 * 60 * 1000,
    enabled: isSearching,
  });

  const activeQuery = isSearching ? searchQuery : trendingQuery;

  return {
    query,
    setQuery: handleQueryChange,
    clearQuery,
    results: activeQuery.data?.results ?? [],
    isLoading: activeQuery.isLoading,
    isError: activeQuery.isError,
    isSearching,
    providerName: useKlipy ? 'KLIPY' : 'GIFverse',
  };
}
