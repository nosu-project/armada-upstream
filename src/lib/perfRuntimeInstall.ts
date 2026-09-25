// Side-effect module: installs the steady-state profiler's probes (WebSocket,
// timers, long frames, the React commit hook). Imported by main.tsx right after
// the polyfills — ES imports are hoisted and evaluated in order, so this runs
// before react-dom looks for its DevTools hook and before any module can open
// a socket or schedule a timer. Kept apart from perfRuntime.ts so that
// importing the report functions never patches globals.
//
// PROFILING BUILDS ONLY (`npm run build:profile`, the perf harness). The probes
// replace `WebSocket`, the timer functions and the DevTools hook for the whole
// page, which is not something to ship; the constant folds, so a normal build
// drops this call and, with it, the profiler module.
import { installRuntimeProfiler } from "@/lib/perfRuntime";

if (import.meta.env.VITE_PROFILE === "1") installRuntimeProfiler();
