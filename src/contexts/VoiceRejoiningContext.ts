import { createContext } from "react";

/** True while PersistentVoiceRoom is rejoining a dropped call (see voiceRejoin.ts). */
export const VoiceRejoiningContext = createContext(false);
