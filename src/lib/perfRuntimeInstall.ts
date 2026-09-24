// Side-effect module: installs the steady-state profiler's probes (WebSocket,
// timers, long frames, the React commit hook). Imported by main.tsx right after
// the polyfills — ES imports are hoisted and evaluated in order, so this runs
// before react-dom looks for its DevTools hook and before any module can open
// a socket or schedule a timer. Kept apart from perfRuntime.ts so that
// importing the report functions never patches globals.
import { installRuntimeProfiler } from "@/lib/perfRuntime";

installRuntimeProfiler();
