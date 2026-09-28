// Imported FIRST by main.tsx so polyfills exist before any module evaluates
// (imports are hoisted, so main.tsx's body would run too late).
import { installAbortSignalPolyfills } from "@/lib/abortSignalPolyfill";

installAbortSignalPolyfills();
