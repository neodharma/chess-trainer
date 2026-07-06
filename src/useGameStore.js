import { useSyncExternalStore } from "react";

export function useGameStore(store) {
  return useSyncExternalStore(store.subscribe, store.getState);
}
