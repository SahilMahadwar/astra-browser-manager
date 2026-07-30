import { useCallback, useRef, useState } from "react";
import type { ConfirmRequest } from "../components/ConfirmDialog";

/**
 * Gives callers the ergonomics of `window.confirm` — `if (await confirm({...}))`
 * — without blocking the event loop. The resolver is parked in a ref until the
 * user answers.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => {
    setRequest(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setRequest(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  return {
    request,
    confirm,
    onConfirm: useCallback(() => settle(true), [settle]),
    onCancel: useCallback(() => settle(false), [settle]),
  };
}
