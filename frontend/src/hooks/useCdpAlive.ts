import { useEffect, useState } from "react";
import { api } from "../lib/api";

// Each check is a real socket probe against Chrome, so keep it well below the
// profile-list cadence.
const POLL_INTERVAL_MS = 10_000;

// One failed probe is not proof of death — Chrome can be briefly busy. Require a
// couple in a row, matching how the profile list debounces "stopped".
const WEDGED_CONFIRM_PROBES = 2;

/**
 * Detects the state the profile list cannot see: the manager still lists a
 * profile as running, but Chrome's CDP port is gone, so the browser is wedged
 * and stop/relaunch is the only way out.
 *
 * Uses `GET /cdp/alive`, which the server has always exposed and the UI never
 * called.
 */
export function useCdpAlive(profileId: string | null, enabled: boolean) {
  const [wedged, setWedged] = useState(false);

  useEffect(() => {
    if (!profileId || !enabled) {
      setWedged(false);
      return;
    }

    let cancelled = false;
    let deadProbes = 0;

    const probe = async () => {
      if (cancelled) return;
      try {
        const { alive } = await api.cdpAlive(profileId);
        if (cancelled) return;
        if (alive) {
          deadProbes = 0;
          setWedged(false);
        } else {
          deadProbes += 1;
          if (deadProbes >= WEDGED_CONFIRM_PROBES) setWedged(true);
        }
      } catch {
        // A 404 means "not running", which the profile list already handles, and
        // a network error is not evidence about Chrome. Neither is wedged.
        if (!cancelled) {
          deadProbes = 0;
          setWedged(false);
        }
      }
    };

    probe();
    const interval = setInterval(probe, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [profileId, enabled]);

  return wedged;
}
