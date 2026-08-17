import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// Node.js 22 has a built-in `localStorage` that lacks standard Web Storage API
// methods (getItem, setItem, etc.) unless `--localstorage-file` is provided.
// This conflicts with jsdom's proper localStorage, so we override the global.
const localStorageMap = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => localStorageMap.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageMap.set(key, value); },
  removeItem: (key: string) => { localStorageMap.delete(key); },
  clear: () => { localStorageMap.clear(); },
  get length() { return localStorageMap.size; },
  key: (index: number) => [...localStorageMap.keys()][index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// The DOM mocks below only apply in jsdom suites — a few pure-logic suites
// (e.g. the SQLite store against node:sqlite) run with
// `@vitest-environment node`, where there is no `window`.
if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock window.scrollTo
  Object.defineProperty(window, 'scrollTo', {
    writable: true,
    value: vi.fn(),
  });
}

// Mock IntersectionObserver. Like ResizeObserver below it has to be a real
// constructor, not a `vi.fn` returning a plain object: components observe with
// `new IntersectionObserver(...)` (the video player's scroll-to-pause, deferred
// rows), which throws "is not a constructor" against a mock that can't be
// `new`'d. Tests that need to drive intersection callbacks stub their own.
global.IntersectionObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = '';
  thresholds = [];
  constructor(_callback: IntersectionObserverCallback) {}
} as unknown as typeof IntersectionObserver;

// Mock ResizeObserver. It has to be a real constructor, not an arrow
// function: Radix measures with `new ResizeObserver(...)` (`useSize`), so any
// component built on it — Checkbox, Select, Tooltip — fails to render against
// a mock that can't be `new`'d.
global.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};