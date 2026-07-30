import { useCallback, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const DEFAULT_TTL_MS = 3500;
// Errors stay longer — they usually carry a message worth reading.
const ERROR_TTL_MS = 6000;

/**
 * Minimal transient-notification store. There is no success feedback anywhere in
 * the app today: a save that worked and a save that silently did nothing look
 * identical.
 */
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      const ttl = kind === "error" ? ERROR_TTL_MS : DEFAULT_TTL_MS;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ttl),
      );
      return id;
    },
    [dismiss],
  );

  const success = useCallback((message: string) => push("success", message), [push]);
  const error = useCallback((message: string) => push("error", message), [push]);
  const info = useCallback((message: string) => push("info", message), [push]);

  return { toasts, dismiss, success, error, info };
}
