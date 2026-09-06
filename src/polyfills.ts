// Runtime polyfills. Imported FIRST by main.tsx as a side effect, so they are
// in place before any other module evaluates — ES imports are hoisted, so a
// call from main.tsx's body would run only after every import had already
// been evaluated.
import { installAbortSignalPolyfills } from "@/lib/abortSignalPolyfill";

installAbortSignalPolyfills();
