import { useCallback, useRef } from "react";
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";

/**
 * `useNavigate`, but with ONE identity for the life of the component.
 *
 * React Router's `navigate` is rebuilt on every location change, so any
 * callback that closes over it changes identity on every navigation — and a
 * callback handed to every row of a memoized list (or to a memoized pane)
 * then re-renders all of them on the way out of the route they are leaving.
 * The returned function always calls the CURRENT `navigate`.
 *
 * The CALLER still re-renders on navigation (this calls `useNavigate`); only
 * what it hands down is stabilized. For a hook every list row calls, read the
 * router through `lib/locationRef.ts` instead, as `useOpenProfile` does.
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
