import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BinaryStatus } from "../lib/api";

// The installed version only changes when an update finishes, so idle polling is
// slow. While a ~70MB download runs there is nothing else reporting progress, so
// the poll tightens to keep the button honest.
const IDLE_POLL_MS = 60_000;
const ACTIVE_POLL_MS = 3_000;

/**
 * `GET /api/binary` — which Chromium is installed and whether a newer release
 * exists. Separate from `useSystemStatus` because it reaches out to GitHub and
 * must not ride the same cadence.
 */
export function useBinaryStatus() {
  const [binary, setBinary] = useState<BinaryStatus | null>(null);
  const updating = binary?.update.state === "running";
  // Read inside the interval callback so changing cadence needs no re-subscribe.
  const updatingRef = useRef(updating);
  updatingRef.current = updating;

  const load = useCallback(async () => {
    try {
      setBinary(await api.getBinary());
    } catch {
      // Non-essential chrome — the profile list already reports connectivity.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      await load();
      if (cancelled) return;
      timer = setTimeout(tick, updatingRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  /** Resolves to an error message when the update could not be started, else null. */
  const startUpdate = useCallback(async (): Promise<string | null> => {
    try {
      const update = await api.updateBinary();
      setBinary((prev) => (prev ? { ...prev, update } : prev));
      await load();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Could not start the update";
    }
  }, [load]);

  return { binary, updating, startUpdate, refresh: load };
}
