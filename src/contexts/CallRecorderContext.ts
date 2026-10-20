import { createContext, useContext } from "react";

export type CallRecorderStatus = "idle" | "starting" | "recording" | "saving";

/** The local take, provided by `CallRecorderProvider` for the life of a call. */
export interface CallRecorderValue {
  /** A Concord call in a runtime that can record. */
  available: boolean;
  status: CallRecorderStatus;
  /** Wall-clock start of our take, for the timer. */
  startedAt: number | null;
  /** Pubkeys whose voices are going into our take right now. */
  capturing: ReadonlySet<string>;
  openDialog: () => void;
  stop: () => void;
}

export const CallRecorderContext = createContext<CallRecorderValue>({
  available: false,
  status: "idle",
  startedAt: null,
  capturing: new Set(),
  openDialog: () => {},
  stop: () => {},
});

export function useCallRecorder(): CallRecorderValue {
  return useContext(CallRecorderContext);
}
