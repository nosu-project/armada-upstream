import { useCallback, useRef } from "react";
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";

/**
 * `useNavigate` with one stable identity, so callbacks handed to memoized rows don't change on
 * every navigation. The caller itself still re-renders; for per-row hooks use `lib/locationRef.ts`
 * (as `useOpenProfile` does).
 */
export function useStableNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const ref = useRef(navigate);
  ref.current = navigate;
  return useCallback(
    ((to: To | number, options?: NavigateOptions) =>
      typeof to === "number" ? ref.current(to) : ref.current(to, options)) as NavigateFunction,
    [],
  );
}
