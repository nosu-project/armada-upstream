// Side-effect module installing the steady-state profiler's probes. Imported by
// main.tsx right after the polyfills so it runs before react-dom looks for its
// DevTools hook and before any socket or timer. PROFILING BUILDS ONLY: the
// constant folds and normal builds drop this call.
import { installRuntimeProfiler } from "@/lib/perfRuntime";

if (import.meta.env.VITE_PROFILE === "1") installRuntimeProfiler();
