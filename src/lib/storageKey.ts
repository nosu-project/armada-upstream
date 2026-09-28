/** Namespaced localStorage key (`appId:suffix`) so forks on one origin don't collide. */
export function getStorageKey(appId: string, suffix: string): string {
  return `${appId}:${suffix}`;
}
