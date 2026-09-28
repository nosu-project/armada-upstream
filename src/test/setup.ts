import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// jest-dom matchers only where there's a DOM (gated on environment, since
// docblock-jsdom files run in the `node` project too). The `/vitest` subpath
// is importable; the bare entry is a global type reference.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

// Node 22's built-in `localStorage` lacks the Web Storage methods without
// `--localstorage-file`; override it.
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

// DOM mocks only in jsdom suites (`@vitest-environment node` has no `window`).
if (typeof window !== 'undefined') {
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

  Object.defineProperty(window, 'scrollTo', {
    writable: true,
    value: vi.fn(),
  });
}

// IntersectionObserver/ResizeObserver mocks must be real constructors:
// components (and Radix `useSize`) call them with `new`.
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

global.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};