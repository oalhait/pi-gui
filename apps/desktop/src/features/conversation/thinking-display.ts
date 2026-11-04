/*
 * How the timeline shows a model's reasoning. A renderer-only display preference, kept in
 * this profile's localStorage like the locale, and followed across windows through the
 * `storage` event.
 */
import { useCallback, useSyncExternalStore } from "react";

export type ThinkingDisplay = "expanded" | "collapsed" | "hidden";

export const THINKING_DISPLAY_STORAGE_KEY = "pi-gui:thinking-display";
export const DEFAULT_THINKING_DISPLAY: ThinkingDisplay = "collapsed";

const thinkingDisplays: readonly ThinkingDisplay[] = ["expanded", "collapsed", "hidden"];

export function parseThinkingDisplay(raw: unknown): ThinkingDisplay {
  return typeof raw === "string" && (thinkingDisplays as readonly string[]).includes(raw)
    ? (raw as ThinkingDisplay)
    : DEFAULT_THINKING_DISPLAY;
}

function readThinkingDisplay(): ThinkingDisplay {
  try {
    return parseThinkingDisplay(localStorage.getItem(THINKING_DISPLAY_STORAGE_KEY));
  } catch {
    return DEFAULT_THINKING_DISPLAY;
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THINKING_DISPLAY_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useThinkingDisplay(): readonly [ThinkingDisplay, (next: ThinkingDisplay) => void] {
  const value = useSyncExternalStore(subscribe, readThinkingDisplay);
  const setValue = useCallback((next: ThinkingDisplay) => {
    try {
      localStorage.setItem(THINKING_DISPLAY_STORAGE_KEY, next);
    } catch {
      // Saving is best-effort; listeners still reread the current value.
    }
    for (const listener of listeners) listener();
  }, []);
  return [value, setValue] as const;
}
