import { createContext, useContext } from "react";

import type { UsePushNotificationsReturn } from "@/lib/pushPrefs";

export const WebPushContext = createContext<UsePushNotificationsReturn | undefined>(undefined);

export function useWebPushNotifications(): UsePushNotificationsReturn {
  const value = useContext(WebPushContext);
  if (!value) throw new Error("useWebPushNotifications must be used inside WebPushNotifications");
  return value;
}
