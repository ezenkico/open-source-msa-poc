import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export function useDebouncedCallback(
  callback: () => void,
  delayMs: number,
  resetKeys: readonly unknown[],
): { schedule: () => void; cancel: () => void } {
  const callbackRef = useRef(callback);
  const timeoutRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const cancel = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    cancel();
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      callbackRef.current();
    }, delayMs);
  }, [cancel, delayMs]);

  useEffect(() => cancel, [cancel, ...resetKeys]);

  return { schedule, cancel };
}
