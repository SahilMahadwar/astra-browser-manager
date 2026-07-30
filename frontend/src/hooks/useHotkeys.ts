import { useEffect, useRef } from "react";

export interface Hotkey {
  /** Lowercase `event.key`, or "Escape" / "ArrowUp" / "ArrowDown". */
  key: string;
  /** Require Ctrl (Windows/Linux) or Cmd (macOS). */
  mod?: boolean;
  handler: (e: KeyboardEvent) => void;
  /**
   * Fire even while a text field has focus. Off by default so typing a "j" in
   * the name field does not navigate the list.
   */
  allowInInput?: boolean;
}

const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function inTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return TEXT_ENTRY.has(el.tagName) || el.isContentEditable;
}

/**
 * Global keyboard shortcuts. Bindings are read from a ref so callers can pass a
 * fresh array each render without re-registering the listener.
 */
export function useHotkeys(hotkeys: Hotkey[]) {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      for (const hotkey of ref.current) {
        if (key !== hotkey.key) continue;
        if (!!hotkey.mod !== mod) continue;
        if (!hotkey.allowInInput && inTextEntry(e.target)) continue;
        e.preventDefault();
        hotkey.handler(e);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
