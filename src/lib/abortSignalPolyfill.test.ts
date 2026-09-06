import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortSignalAny,
  abortSignalTimeout,
  installAbortSignalPolyfills,
} from "@/lib/abortSignalPolyfill";

const statics = AbortSignal as unknown as Record<string, unknown>;
const nativeAny = statics.any;
const nativeTimeout = statics.timeout;

afterEach(() => {
  statics.any = nativeAny;
  statics.timeout = nativeTimeout;
  vi.useRealTimers();
});

describe("abortSignalAny", () => {
  it("aborts with the reason of whichever source aborts first", () => {
    const a = new AbortController();
    const b = new AbortController();
    const signal = abortSignalAny([a.signal, b.signal]);

    expect(signal.aborted).toBe(false);
    b.abort(new Error("b first"));

    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("b first");
    a.abort(new Error("a later"));
    expect((signal.reason as Error).message).toBe("b first");
  });

  it("is already aborted when a source is", () => {
    const done = new AbortController();
    done.abort("gone");
    const live = new AbortController();

    const signal = abortSignalAny([live.signal, done.signal]);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("gone");
  });

  it("fires abort listeners on the composed signal", () => {
    const a = new AbortController();
    const signal = abortSignalAny([a.signal]);
    const onAbort = vi.fn();
    signal.addEventListener("abort", onAbort);

    a.abort();

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("detaches from every source once one aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const remove = vi.spyOn(b.signal, "removeEventListener");

    abortSignalAny([a.signal, b.signal]);
    a.abort();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("never aborts with no sources", () => {
    expect(abortSignalAny([]).aborted).toBe(false);
  });
});

describe("abortSignalTimeout", () => {
  it("aborts with a TimeoutError after the deadline", () => {
    vi.useFakeTimers();
    const signal = abortSignalTimeout(500);

    vi.advanceTimersByTime(499);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe("TimeoutError");
  });
});

describe("installAbortSignalPolyfills", () => {
  it("leaves native statics alone", () => {
    installAbortSignalPolyfills();
    expect(statics.any).toBe(nativeAny);
    expect(statics.timeout).toBe(nativeTimeout);
  });

  it("fills in AbortSignal.any where it is missing", () => {
    delete statics.any;
    expect(typeof statics.any).toBe("undefined");

    installAbortSignalPolyfills();

    expect(statics.any).toBe(abortSignalAny);
    expect(statics.timeout).toBe(nativeTimeout);
    const a = new AbortController();
    const composed = AbortSignal.any([a.signal, AbortSignal.timeout(60_000)]);
    a.abort();
    expect(composed.aborted).toBe(true);
  });

  it("fills in AbortSignal.timeout where it is missing", () => {
    delete statics.timeout;

    installAbortSignalPolyfills();

    expect(statics.timeout).toBe(abortSignalTimeout);
    expect(statics.any).toBe(nativeAny);
  });
});
