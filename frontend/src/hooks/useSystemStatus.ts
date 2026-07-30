import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../lib/api";

// The binary version never changes at runtime and the counts are already visible
// from the profile list, so this needs nowhere near the 3s profile cadence.
const POLL_INTERVAL_MS = 30_000;

/** `GET /api/status` — implemented since the first release and never called. */
export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await api.getStatus();
        if (!cancelled) setStatus(next);
      } catch {
        // Non-essential chrome — the profile list already reports connectivity.
      }
    };

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}
