import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Profile, type ProfileCreateData } from "../lib/api";

const POLL_INTERVAL_MS = 3000;

// A single poll reporting a non-running status used to unmount the VNC viewer
// outright, tearing down a healthy session over one transient blip. Require this
// many consecutive non-running polls before believing the browser is really gone.
const STOPPED_CONFIRM_POLLS = 2;

export function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Two error channels on purpose. Poll errors are transient and self-clearing;
  // action errors ("proxy URL missing port") are the user's to read and dismiss,
  // and were previously wiped by the very next poll ~3s later — which made every
  // failed save, launch, and delete effectively invisible.
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tracks consecutive non-running observations per profile. Keyed off actual
  // polls rather than React render identity, so StrictMode's double-invoke can't
  // inflate the count and a stalled poll can't freeze it.
  const stoppedStreaks = useRef(new Map<string, number>());
  const [confirmedStopped, setConfirmedStopped] = useState<Set<string>>(new Set());

  const observe = useCallback((data: Profile[]) => {
    const streaks = stoppedStreaks.current;
    const confirmed = new Set<string>();

    for (const profile of data) {
      if (profile.status === "running") {
        streaks.set(profile.id, 0);
        continue;
      }
      const next = (streaks.get(profile.id) ?? 0) + 1;
      streaks.set(profile.id, next);
      if (next >= STOPPED_CONFIRM_POLLS) confirmed.add(profile.id);
    }

    // Drop profiles that no longer exist so the map cannot grow unbounded.
    const live = new Set(data.map((p) => p.id));
    for (const id of streaks.keys()) if (!live.has(id)) streaks.delete(id);

    setConfirmedStopped((prev) => {
      if (prev.size === confirmed.size && [...confirmed].every((id) => prev.has(id))) {
        return prev; // preserve identity so dependent effects don't re-fire
      }
      return confirmed;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listProfiles();
      setProfiles(data);
      observe(data);
      setPollError(null);
    } catch (err) {
      setPollError(err instanceof Error ? err.message : "Failed to fetch profiles");
    } finally {
      setLoading(false);
    }
  }, [observe]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clears both channels: a poll error that is still real comes straight back on
  // the next tick, so there is no reason to make it undismissable.
  const dismissError = useCallback(() => {
    setActionError(null);
    setPollError(null);
  }, []);

  const create = useCallback(
    async (data: ProfileCreateData): Promise<Profile | undefined> => {
      try {
        const profile = await api.createProfile(data);
        setProfiles((prev) => [profile, ...prev]);
        setActionError(null);
        return profile;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to create profile");
      }
    },
    [],
  );

  const update = useCallback(
    async (id: string, data: Partial<ProfileCreateData>) => {
      try {
        const profile = await api.updateProfile(id, data);
        setProfiles((prev) => prev.map((p) => (p.id === id ? profile : p)));
        setActionError(null);
        return profile;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to update profile");
      }
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteProfile(id);
        setProfiles((prev) => prev.filter((p) => p.id !== id));
        setActionError(null);
        return true;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to delete profile");
      }
    },
    [],
  );

  const launch = useCallback(
    async (id: string) => {
      try {
        const result = await api.launchProfile(id);
        // A fresh launch must not inherit the streak from before it started.
        stoppedStreaks.current.set(id, 0);
        setActionError(null);
        await refresh();
        return result;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to launch profile");
      }
    },
    [refresh],
  );

  const stop = useCallback(
    async (id: string) => {
      try {
        await api.stopProfile(id);
        setActionError(null);
        await refresh();
        return true;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to stop profile");
      }
    },
    [refresh],
  );

  return {
    profiles,
    loading,
    // Action errors take precedence — they are the ones the user acted to cause.
    error: actionError ?? pollError,
    dismissError,
    confirmedStopped,
    refresh,
    create,
    update,
    remove,
    launch,
    stop,
  };
}
