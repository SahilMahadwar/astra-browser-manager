import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface ThumbnailProps {
  profileId: string;
  running: boolean;
  className?: string;
}

// Screenshots are far more expensive than a profile list poll, so they refresh on
// their own slow cadence and only while the profile is actually running.
const REFRESH_INTERVAL_MS = 15_000;

/**
 * Live preview for a running profile, last-seen image for a stopped one. Renders
 * nothing at all if the server has no screenshot — a broken-image icon would be
 * worse than an absent one.
 */
export function Thumbnail({ profileId, running, className }: ThumbnailProps) {
  const [version, setVersion] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [profileId]);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setVersion(Date.now()), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running, profileId]);

  if (failed) return null;

  return (
    <img
      src={api.screenshotUrl(profileId, version)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
