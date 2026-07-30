import { Play, Square, Loader2 } from "lucide-react";
import { useState } from "react";

interface LaunchButtonProps {
  status: "running" | "stopped";
  onLaunch: () => Promise<void>;
  onStop: () => Promise<void>;
  /**
   * "toolbar" is the header action on a form/viewer page. "card" is the wide
   * half-width pair inside a dashboard card, where stop is neutral rather than
   * destructive-looking — a whole grid of red buttons reads as an error state.
   */
  variant?: "toolbar" | "card";
}

export function LaunchButton({
  status,
  onLaunch,
  onStop,
  variant = "toolbar",
}: LaunchButtonProps) {
  const [loading, setLoading] = useState(false);
  const card = variant === "card";
  const width = card ? "flex-1" : "";

  // No local error state: useProfiles already catches launch/stop failures and
  // surfaces them in the (dismissable) app-level banner, so a try/catch here
  // could never fire and its error render was dead code.
  const handleClick = async () => {
    setLoading(true);
    try {
      if (status === "running") {
        await onStop();
      } else {
        await onLaunch();
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <button disabled className={`btn-secondary opacity-60 cursor-not-allowed ${width}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{status === "running" ? "Stopping..." : "Launching..."}</span>
      </button>
    );
  }

  if (status === "running") {
    return (
      <button onClick={handleClick} className={`${card ? "btn-secondary" : "btn-danger"} ${width}`}>
        <Square className="h-3 w-3 fill-current" />
        <span>Stop</span>
      </button>
    );
  }

  return (
    <button onClick={handleClick} className={`btn-launch ${width}`}>
      <Play className="h-3 w-3 fill-current" />
      <span>{card ? "Start" : "Launch"}</span>
    </button>
  );
}
